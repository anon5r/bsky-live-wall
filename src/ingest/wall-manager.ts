/**
 * Jetstream 受信からモデレーション・プロフィール解決・格納までを束ね、
 * WallSource として server 層へ公開する。
 *
 * 複数のウォールを扱う。Jetstream 接続は 1 本だけ張り、受信した投稿を
 * 各ウォールの監視語と突き合わせて振り分ける。接続をウォールごとに張ると
 * 同じ全量を何度も受信することになり、帯域と相手側の負荷が無駄に増える。
 *
 * 共有: モデレーション (ブロック / 非表示 / NG ワード / リスト購読 / 一時停止)
 * 個別: 監視語 / 投稿バッファ / 承認待ち / 表示設定
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { buildTerms, type AppConfig } from '../shared/config.js';
import type {
  BackfillStatus,
  DisplayConfig,
  JetstreamEvent,
  ModListInfo,
  WallPost,
  WallState,
  WallSummary,
  WatchTerm,
  WatchTermType,
} from '../shared/types.js';
import type { WallHandle, WallSource, WallSourceEvents } from '../shared/contracts.js';
import type { IngestHub } from '../shared/ingest-contracts.js';
import { createLogger } from '../shared/logger.js';
import { ModListManager } from './modlist.js';
import { matchHashtags } from './hashtag-matcher.js';
import { matchKeywords } from './keyword-matcher.js';
import { evaluate } from './moderator.js';
import { mapToWallPost } from './post-mapper.js';
import { Wall, displayFromConfig, normalizeWallId } from './wall.js';

const log = createLogger('wall-manager');

const STATE_THROTTLE_MS = 1000;
const POST_COLLECTION = 'app.bsky.feed.post';
/** 非表示にした uri を覚えておく上限。 */
const HIDDEN_URI_LIMIT = 5000;
/** 1 ウォールあたりの監視語の上限。 */
const MAX_TERMS = 20;
/** ウォール数の上限。 */
const MAX_WALLS = 10;
/** バックフィル中にライブ側で観測した削除を覚えておく上限。 */
const BACKFILL_DELETED_LIMIT = 50_000;

export const DEFAULT_WALL_ID = 'main';

export class WallManager extends EventEmitter implements WallSource {
  private readonly config: AppConfig;
  private readonly hub: IngestHub;
  private readonly modLists: ModListManager;

  private readonly walls = new Map<string, Wall>();

  private paused = false;

  /** 運営が非表示にした投稿。再配信されても復活させないために保持する。 */
  private readonly hiddenUris = new Set<string>();
  private readonly hiddenPosts = new Map<string, WallPost>();
  /** バックフィルが到達する前にライブ側で削除が観測された uri。 */
  private backfillDeleted = new Set<string>();
  private backfillDroppedCount = 0;
  /** 取り込み対象のウォール。null なら全ウォール。 */
  private backfillTargets: string[] | null = null;
  /** 直近のバックフィル要求で指定されたウォール (状態表示用)。 */
  private backfillTargetWallId: string | null = null;
  /** 直近のバックフィルで表示に加わった件数。 */
  private backfillAdded = 0;

  private readonly stateEmitTimers = new Map<string, NodeJS.Timeout>();
  private readonly stateEmitPending = new Set<string>();

  declare on: <K extends keyof WallSourceEvents>(event: K, listener: WallSourceEvents[K]) => this;
  declare off: <K extends keyof WallSourceEvents>(event: K, listener: WallSourceEvents[K]) => this;
  declare emit: <K extends keyof WallSourceEvents>(
    event: K,
    ...args: Parameters<WallSourceEvents[K]>
  ) => boolean;

  constructor(config: AppConfig, hub: IngestHub) {
    super();
    this.config = config;
    this.hub = hub;
    this.modLists = new ModListManager(config);

    // 既定ウォールは .env から作る。`/wall` はこれを開く。
    const defaultWall = new Wall(
      DEFAULT_WALL_ID,
      config.event.title || 'メイン',
      config.event.terms,
      displayFromConfig(config),
      true,
      config.buffer.size
    );
    this.walls.set(defaultWall.id, defaultWall);

    // 接続状態はハブが持つ。ここでは再描画のきっかけにするだけ。
    this.hub.on('status', () => this.emitStateAll());

    this.hub.on('commit', (commit) => {
      // 段階 2-a では単一テナントのみなので backfillOwner は常に自分宛だが、
      // 将来複数テナントが同じハブを共有したときに備えて明示的に照合する。
      if (commit.source === 'backfill' && commit.backfillOwner !== this.config.event.id) return;
      this.handleCommit(commit.event, commit.source);
    });
    this.hub.on('backfillDone', () => {
      this.backfillAdded = this.flushBackfill();
      this.backfillTargets = null;
      this.emitStateAll();
    });

    this.hub.on('profile', ({ did, author }) => {
      let updated = false;
      for (const wall of this.walls.values()) {
        if (wall.store.updateAuthor(did, author).length > 0) updated = true;
      }
      if (updated) this.emit('profile', { did, author });
    });
  }

  // ---- ライフサイクル ----

  async start(): Promise<void> {
    await this.hub.start();
    if (this.config.jetstream.startupBackfillMinutes > 0) {
      this.startBackfill({ minutes: this.config.jetstream.startupBackfillMinutes });
    }
    this.modLists.start();
  }

  async stop(): Promise<void> {
    this.modLists.stop();
    await this.hub.stop();
    for (const timer of this.stateEmitTimers.values()) clearTimeout(timer);
    this.stateEmitTimers.clear();
  }

  // ---- ウォール ----

  getWalls(): WallSummary[] {
    return [...this.walls.values()].map((w) => w.toSummary());
  }

  getWall(id: string): WallHandle | undefined {
    const wall = this.walls.get(id);
    return wall ? this.makeHandle(wall) : undefined;
  }

  getDefaultWall(): WallHandle {
    const wall = this.walls.get(DEFAULT_WALL_ID);
    if (!wall) throw new Error('既定ウォールがありません');
    return this.makeHandle(wall);
  }

  createWall(input: {
    id?: string;
    name: string;
    terms: { value: string; type: WatchTermType }[];
    display?: Partial<DisplayConfig>;
  }): WallSummary {
    if (this.walls.size >= MAX_WALLS) {
      throw new Error(`ウォールは ${MAX_WALLS} 個までです`);
    }
    // 監視語なしのウォールも作れる。作ってから設定する運用のため。
    const terms = buildTerms(input.terms).slice(0, MAX_TERMS);

    let id = normalizeWallId(input.id ?? input.name);
    if (id === '' || this.walls.has(id)) {
      // 衝突や空になった場合は一意な ID を振る。
      id = `wall-${randomBytes(3).toString('hex')}`;
    }

    const wall = new Wall(
      id,
      input.name.trim() || id,
      terms,
      { ...displayFromConfig(this.config), ...input.display },
      false,
      this.config.buffer.size
    );
    this.walls.set(id, wall);
    log.info(`ウォールを追加しました: ${wall.name} (${id})`, {
      terms: terms.map((t) => `${t.type}:${t.value}`),
    });
    this.emit('walls', this.getWalls());
    return wall.toSummary();
  }

  deleteWall(id: string): boolean {
    const wall = this.walls.get(id);
    if (!wall || wall.isDefault) return false;
    this.walls.delete(id);
    this.stateEmitPending.delete(id);
    const timer = this.stateEmitTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.stateEmitTimers.delete(id);
    }
    log.info(`ウォールを削除しました: ${wall.name} (${id})`);
    this.emit('walls', this.getWalls());
    return true;
  }

  updateWall(
    id: string,
    input: { name?: string; display?: Partial<DisplayConfig> }
  ): WallSummary | undefined {
    const wall = this.walls.get(id);
    if (!wall) return undefined;
    if (input.name !== undefined && input.name.trim() !== '') wall.name = input.name.trim();
    if (input.display) wall.display = { ...wall.display, ...input.display };
    this.emit('walls', this.getWalls());
    this.scheduleStateEmit(id);
    return wall.toSummary();
  }

  private makeHandle(wall: Wall): WallHandle {
    return {
      id: wall.id,
      getState: () => this.buildState(wall),
      getRecent: (limit) => wall.store.getRecent(limit),
      getPending: (limit) => wall.store.getPending(limit),
      getTerms: () => wall.terms,
      setTerms: (input) => {
        // 空にすることも許す。設定をやり直す途中経過として起こりうるため。
        // 監視語が無いウォールは何も拾わず、待機画面のままになる。
        const terms = buildTerms(input).slice(0, MAX_TERMS);
        wall.terms = terms;
        log.info(`監視語を変更しました (${wall.id})`, {
          terms: terms.map((t) => `${t.type}:${t.value}`),
        });
        this.emit('walls', this.getWalls());
        this.scheduleStateEmit(wall.id);
        return terms;
      },
      approve: (uri) => {
        const post = wall.store.promotePending(uri);
        if (!post) return false;
        if (!this.paused) this.emit('post', wall.id, post);
        this.scheduleStateEmit(wall.id);
        return true;
      },
      clear: () => {
        const targets = [
          ...wall.store.getRecent(Number.MAX_SAFE_INTEGER),
          ...wall.store.getPending(Number.MAX_SAFE_INTEGER),
        ];
        wall.store.clear();
        for (const post of targets) {
          this.emit('remove', wall.id, { uri: post.uri, reason: 'cleared' });
        }
        this.scheduleStateEmit(wall.id);
      },
    };
  }

  // ---- 全ウォール共通のモデレーション ----

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.emitStateAll();
  }

  isPaused(): boolean {
    return this.paused;
  }

  hide(uri: string): boolean {
    let removed = false;
    for (const wall of this.walls.values()) {
      const post = wall.store.get(uri);
      if (post) this.stashHidden(post);
      if (wall.store.remove(uri, 'hidden')) {
        this.emit('remove', wall.id, { uri, reason: 'hidden' });
        this.scheduleStateEmit(wall.id);
        removed = true;
      }
    }
    this.rememberHidden(uri);
    return removed;
  }

  unhide(uri: string): boolean {
    const post = this.hiddenPosts.get(uri);
    if (!post) return false;
    this.hiddenPosts.delete(uri);
    this.hiddenUris.delete(uri);
    // 監視語に一致するウォールすべてへ戻す。
    for (const wall of this.walls.values()) {
      if (this.wallMatches(wall, post)) this.restore(wall, post);
    }
    return true;
  }

  getHidden(limit: number): WallPost[] {
    const n = Math.max(0, limit);
    return [...this.hiddenPosts.values()].sort((a, b) => b.timeUs - a.timeUs).slice(0, n);
  }

  getBlockedActors(): string[] {
    return [...this.config.moderation.blockActors];
  }

  blockActor(actor: string): number {
    const needle = actor.toLowerCase();
    if (!this.config.moderation.blockActors.includes(needle)) {
      this.config.moderation.blockActors.push(needle);
    }
    let count = 0;
    for (const wall of this.walls.values()) {
      const targets = [
        ...wall.store.getRecent(Number.MAX_SAFE_INTEGER),
        ...wall.store.getPending(Number.MAX_SAFE_INTEGER),
      ];
      for (const post of targets) {
        if (post.did.toLowerCase() !== needle && post.author.handle.toLowerCase() !== needle) {
          continue;
        }
        this.stashHidden(post);
        this.rememberHidden(post.uri);
        if (wall.store.remove(post.uri, 'hidden')) {
          this.emit('remove', wall.id, { uri: post.uri, reason: 'hidden' });
          count += 1;
        }
      }
      this.scheduleStateEmit(wall.id);
    }
    return count;
  }

  unblockActor(actor: string): number {
    const needle = actor.toLowerCase();
    const idx = this.config.moderation.blockActors.indexOf(needle);
    if (idx >= 0) this.config.moderation.blockActors.splice(idx, 1);

    let count = 0;
    for (const post of [...this.hiddenPosts.values()]) {
      if (post.did.toLowerCase() !== needle && post.author.handle.toLowerCase() !== needle) continue;
      this.hiddenPosts.delete(post.uri);
      this.hiddenUris.delete(post.uri);
      for (const wall of this.walls.values()) {
        if (this.wallMatches(wall, post)) {
          this.restore(wall, post);
          count += 1;
        }
      }
    }
    return count;
  }

  // ---- バックフィル ----

  startBackfill(input: { minutes: number; wallId?: string }): { ok: boolean; message?: string } {
    // ウォールの存在確認はテナント (ウォール) 側の関心事なのでここで見る。
    // 分数の妥当性チェックや同時実行の制御はハブへ委譲する。
    if (input.wallId !== undefined && !this.walls.has(input.wallId)) {
      return { ok: false, message: '指定されたウォールがありません' };
    }

    const result = this.hub.startBackfill({
      minutes: input.minutes,
      owner: this.config.event.id,
    });
    if (!result.ok) return result;

    this.backfillTargets = input.wallId ? [input.wallId] : null;
    this.backfillTargetWallId = input.wallId ?? null;
    this.backfillAdded = 0;
    this.emitStateAll();
    return { ok: true };
  }

  getBackfillStatus(): BackfillStatus {
    return {
      ...this.hub.getBackfillStatus(),
      targetWallId: this.backfillTargetWallId,
      added: this.backfillAdded,
    };
  }

  /** このウォールが今回の取り込み対象か。 */
  private isBackfillTarget(wallId: string): boolean {
    return this.backfillTargets === null || this.backfillTargets.includes(wallId);
  }

  // ---- Jetstream ----

  getJetstreamHosts(): string[] {
    return this.hub.getHosts();
  }

  switchJetstreamHost(host: string): boolean {
    return this.hub.switchHost(host);
  }

  // ---- モデレーションリスト ----

  getModLists(): ModListInfo[] {
    return this.modLists.list();
  }

  async subscribeModList(uri: string): Promise<{ info: ModListInfo; removed: number }> {
    const { info, dids } = await this.modLists.subscribe(uri);
    const blocked = new Set(dids);
    let removed = 0;
    for (const wall of this.walls.values()) {
      const targets = [
        ...wall.store.getRecent(Number.MAX_SAFE_INTEGER),
        ...wall.store.getPending(Number.MAX_SAFE_INTEGER),
      ];
      for (const post of targets) {
        if (!blocked.has(post.did)) continue;
        this.stashHidden(post);
        if (wall.store.remove(post.uri, 'hidden')) {
          this.emit('remove', wall.id, { uri: post.uri, reason: 'hidden' });
          removed += 1;
        }
      }
      this.scheduleStateEmit(wall.id);
    }
    return { info, removed };
  }

  unsubscribeModList(uri: string): boolean {
    if (!this.modLists.has(uri)) return false;
    this.modLists.unsubscribe(uri);
    return true;
  }

  // ---- 受信処理 ----

  private handleCommit(event: JetstreamEvent, source: 'live' | 'backfill'): void {
    const commit = event.commit;
    if (!commit || commit.collection !== POST_COLLECTION) return;

    const uri = `at://${event.did}/app.bsky.feed.post/${commit.rkey}`;

    if (commit.operation === 'delete') {
      let bufferedHit = false;
      for (const wall of this.walls.values()) {
        if (wall.backfillBuffer.delete(uri)) bufferedHit = true;
        if (wall.store.remove(uri, 'deleted')) {
          this.emit('remove', wall.id, { uri, reason: 'deleted' });
          this.scheduleStateEmit(wall.id);
        }
      }
      if (bufferedHit) this.backfillDroppedCount += 1;
      else if (source === 'live' && this.hub.getStatus().backfilling) {
        this.rememberBackfillDeleted(uri);
      }
      return;
    }

    if (commit.operation !== 'create') return;
    const record = commit.record;
    if (!record) return;
    if (this.hiddenUris.has(uri)) return;
    if (source === 'backfill' && this.backfillDeleted.has(uri)) return;

    // どのウォールが拾うかを先に判定する。1 つも拾わないなら以降の処理は不要。
    const hits: { wall: Wall; tags: string[]; keywords: string[] }[] = [];
    for (const wall of this.walls.values()) {
      if (wall.store.has(uri) || wall.backfillBuffer.has(uri)) continue;
      const tags = matchHashtags(record, wall.normalizedHashtags);
      const keywords = matchKeywords(record, wall.terms);
      if (tags.length === 0 && keywords.length === 0) continue;
      hits.push({ wall, tags, keywords });
    }
    if (hits.length === 0) return;

    for (const hit of hits) hit.wall.store.recordMatched();

    // モデレーションは全ウォール共通なので 1 回だけ評価する。
    if (this.modLists.isBlocked(event.did)) {
      for (const hit of hits) hit.wall.store.recordRejected();
      return;
    }
    const author = this.hub.resolveAuthor(event.did);
    const modResult = evaluate(
      record,
      { did: event.did, handle: author.handle },
      this.config.moderation
    );
    if (!modResult.ok) {
      for (const hit of hits) hit.wall.store.recordRejected();
      return;
    }

    for (const { wall, tags, keywords } of hits) {
      const wallPost = mapToWallPost({
        did: event.did,
        rkey: commit.rkey,
        cid: commit.cid ?? '',
        record,
        timeUs: event.time_us,
        matchedTags: tags,
        matchedKeywords: keywords,
        showImages: wall.display.showImages,
        author,
      });

      if (source === 'backfill') {
        // 対象外のウォールには反映しない (ウォール指定の取り込みに対応するため)。
        if (this.isBackfillTarget(wall.id)) wall.backfillBuffer.set(uri, wallPost);
        continue;
      }

      // ハッシュタグが付いていない投稿は、投稿者がイベントを意識していない
      // 可能性がある。会場スクリーンに無関係な投稿を出さないため確認を挟む。
      const keywordOnly = tags.length === 0 && keywords.length > 0;
      const needsApproval =
        this.config.moderation.mode === 'approve' ||
        (keywordOnly && this.config.moderation.keywordRequireApproval);

      if (needsApproval) {
        const pendingPost: WallPost = { ...wallPost, status: 'pending' };
        wall.store.addPending(pendingPost);
        if (!this.paused) this.emit('pending', wall.id, pendingPost);
      } else {
        wall.store.add(wallPost);
        if (!this.paused) this.emit('post', wall.id, wallPost);
      }
      this.scheduleStateEmit(wall.id);
    }
  }

  /** バックフィルで溜めた投稿を、削除済みを除いて確定させる。 */
  private flushBackfill(): number {
    let total = 0;
    for (const wall of this.walls.values()) {
      const survivors: WallPost[] = [];
      let dropped = 0;
      for (const [uri, post] of wall.backfillBuffer) {
        if (this.backfillDeleted.has(uri) || this.hiddenUris.has(uri)) {
          dropped += 1;
          continue;
        }
        if (wall.store.has(uri)) continue;
        survivors.push(post);
      }
      wall.backfillBuffer = new Map();

      log.info(
        `バックフィル確定 (${wall.id}): ${survivors.length} 件を表示 ` +
          `(削除済み・非表示のため除外: ${dropped + this.backfillDroppedCount} 件)`
      );
      if (survivors.length === 0) continue;
      total += survivors.length;

      survivors.sort((a, b) => b.timeUs - a.timeUs);

      if (this.config.moderation.mode === 'approve') {
        for (const post of survivors) {
          const pendingPost: WallPost = { ...post, status: 'pending' };
          wall.store.addPending(pendingPost);
          if (!this.paused) this.emit('pending', wall.id, pendingPost);
        }
      } else {
        wall.store.addHistory(survivors);
        if (!this.paused) this.emit('history', wall.id, survivors);
      }
      this.scheduleStateEmit(wall.id);
    }
    this.backfillDeleted = new Set();
    this.backfillDroppedCount = 0;
    return total;
  }

  /** 復元した投稿を表示へ戻す。時系列が崩れないよう挿入位置を選ぶ。 */
  private restore(wall: Wall, post: WallPost): void {
    const newest = wall.store.getRecent(1)[0];
    if (newest && newest.timeUs > post.timeUs) {
      wall.store.addHistory([post]);
      if (!this.paused) this.emit('history', wall.id, [post]);
    } else {
      wall.store.add(post);
      if (!this.paused) this.emit('post', wall.id, post);
    }
    this.scheduleStateEmit(wall.id);
  }

  /** 復元先を決めるため、この投稿がウォールの監視語に合うかを見る。 */
  private wallMatches(wall: Wall, post: WallPost): boolean {
    const normalizedTags = new Set(wall.normalizedHashtags);
    for (const tag of post.matchedTags) {
      if (normalizedTags.has(tag.normalize('NFKC').toLowerCase())) return true;
    }
    const keywords = new Set(
      wall.terms.filter((t) => t.type === 'keyword').map((t) => t.normalized)
    );
    for (const kw of post.matchedKeywords) {
      if (keywords.has(kw.normalize('NFKC').toLowerCase())) return true;
    }
    return false;
  }

  private stashHidden(post: WallPost): void {
    this.hiddenPosts.set(post.uri, post);
    if (this.hiddenPosts.size > HIDDEN_URI_LIMIT) {
      const oldest = this.hiddenPosts.keys().next();
      if (!oldest.done) this.hiddenPosts.delete(oldest.value);
    }
  }

  private rememberHidden(uri: string): void {
    this.hiddenUris.add(uri);
    if (this.hiddenUris.size > HIDDEN_URI_LIMIT) {
      const oldest = this.hiddenUris.values().next();
      if (!oldest.done) this.hiddenUris.delete(oldest.value);
    }
  }

  private rememberBackfillDeleted(uri: string): void {
    this.backfillDeleted.add(uri);
    if (this.backfillDeleted.size > BACKFILL_DELETED_LIMIT) {
      const oldest = this.backfillDeleted.values().next();
      if (!oldest.done) this.backfillDeleted.delete(oldest.value);
    }
  }

  // ---- 状態通知 ----

  private buildState(wall: Wall): WallState {
    return {
      wallId: wall.id,
      wallName: wall.name,
      hashtags: wall.hashtags,
      terms: wall.terms,
      eventTitle: this.config.event.title,
      eventSubtitle: this.config.event.subtitle,
      paused: this.paused,
      moderationMode: this.config.moderation.mode,
      jetstream: this.hub.getStatus(),
      stats: wall.store.getStats(),
    };
  }

  private emitStateAll(): void {
    for (const id of this.walls.keys()) this.scheduleStateEmit(id);
  }

  /** ウォールごとにスロットルする。連続する更新で SSE を溢れさせないため。 */
  private scheduleStateEmit(wallId: string): void {
    const wall = this.walls.get(wallId);
    if (!wall) return;
    if (this.stateEmitTimers.has(wallId)) {
      this.stateEmitPending.add(wallId);
      return;
    }
    this.emit('state', wallId, this.buildState(wall));
    const timer = setTimeout(() => {
      this.stateEmitTimers.delete(wallId);
      if (this.stateEmitPending.delete(wallId)) {
        const current = this.walls.get(wallId);
        if (current) this.emit('state', wallId, this.buildState(current));
      }
    }, STATE_THROTTLE_MS);
    this.stateEmitTimers.set(wallId, timer);
  }
}
