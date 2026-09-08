/**
 * Jetstream 受信からモデレーション・プロフィール解決・PostStore 格納までを束ね、
 * WallSource として server 層へ公開する。
 */
import { EventEmitter } from 'node:events';
import { buildTerms, type AppConfig } from '../shared/config.js';
import type {
  ModListInfo,
  WatchTerm,
  JetstreamEvent,
  JetstreamStatus,
  WallPost,
  WallState,
} from '../shared/types.js';
import type { WallSource, WallSourceEvents } from '../shared/contracts.js';
import { createLogger } from '../shared/logger.js';
import { JetstreamClient } from './jetstream-client.js';
import { BackfillReader } from './backfill-reader.js';
import { ModListManager } from './modlist.js';
import { matchHashtags } from './hashtag-matcher.js';
import { matchKeywords } from './keyword-matcher.js';
import { evaluate } from './moderator.js';
import { mapToWallPost } from './post-mapper.js';
import { ProfileHydrator } from './profile-hydrator.js';
import { PostStore } from './post-store.js';

const log = createLogger('pipeline');

const STATE_THROTTLE_MS = 1000;
const POST_COLLECTION = 'app.bsky.feed.post';
/** 非表示にした uri を覚えておく上限。超えた分は古いものから捨てる。 */
const HIDDEN_URI_LIMIT = 5000;
/** 監視語の上限。無制限に増やせると誤設定で全件一致しかねない。 */
const MAX_TERMS = 20;
/** バックフィル中にライブ側で観測した削除を覚えておく上限。 */
const BACKFILL_DELETED_LIMIT = 50_000;

export class WallPipeline extends EventEmitter implements WallSource {
  private readonly config: AppConfig;
  private readonly jetstream: JetstreamClient;
  private readonly backfill: BackfillReader;
  private readonly modLists: ModListManager;
  private readonly hydrator: ProfileHydrator;
  private readonly store: PostStore;

  private paused = false;
  private jetstreamStatus: JetstreamStatus = {
    connected: false,
    host: null,
    lastEventAt: null,
    reconnects: 0,
    cursor: null,
    backfilling: false,
  };

  /**
   * 運営が非表示にした投稿の uri。
   * 再接続時のリプレイやバックフィルで同じ投稿が再配信されても復活させないために保持する。
   */
  private readonly hiddenUris = new Set<string>();
  /** 非表示にした投稿の実体。復元できるようにするために保持する。 */
  private readonly hiddenPosts = new Map<string, WallPost>();

  /**
   * バックフィル中に拾った投稿の一時置き場。
   * 取り込みが完了するまで画面へは出さない。再生の途中で削除コミットが来る投稿を
   * 一度表示してから消す「ちらつき」を防ぐため。
   */
  private backfillBuffer = new Map<string, WallPost>();
  /**
   * バックフィルが到達する前にライブ側で削除が観測された uri。
   * 再生が後からその投稿の作成に追いついても表示しないために保持する。
   * バックフィル自身が流す過去の削除はバッファから直接取り除くので保持不要。
   */
  private backfillDeleted = new Set<string>();
  /** バックフィルで削除により除外した件数 (ログ用)。 */
  private backfillDroppedCount = 0;

  private stateEmitTimer: NodeJS.Timeout | null = null;
  private stateEmitPending = false;

  declare on: <K extends keyof WallSourceEvents>(event: K, listener: WallSourceEvents[K]) => this;
  declare off: <K extends keyof WallSourceEvents>(
    event: K,
    listener: WallSourceEvents[K]
  ) => this;
  declare emit: <K extends keyof WallSourceEvents>(
    event: K,
    ...args: Parameters<WallSourceEvents[K]>
  ) => boolean;

  constructor(config: AppConfig) {
    super();
    this.config = config;
    this.jetstream = new JetstreamClient(config.jetstream);
    this.backfill = new BackfillReader(config.jetstream);
    this.modLists = new ModListManager(config);
    this.hydrator = new ProfileHydrator(config);
    this.store = new PostStore({ size: config.buffer.size, pendingSize: config.buffer.size });

    this.jetstream.on('open', (host) => {
      this.jetstreamStatus = { ...this.jetstreamStatus, connected: true, host };
      this.scheduleStateEmit();
    });
    this.jetstream.on('close', () => {
      this.jetstreamStatus = {
        ...this.jetstreamStatus,
        connected: false,
        reconnects: this.jetstreamStatus.reconnects + 1,
      };
      this.scheduleStateEmit();
    });
    this.jetstream.on('error', (err) => {
      log.warn('Jetstream エラー', err);
    });
    this.jetstream.on('commit', (event) => this.handleCommit(event, 'live'));

    // バックフィルはライブ受信と並行して走る。取り込み口は同じで、
    // 重複した投稿は PostStore が uri で弾く。
    this.backfill.on('commit', (event) => this.handleCommit(event, 'backfill'));
    this.backfill.on('done', () => {
      this.flushBackfill();
      this.jetstreamStatus = { ...this.jetstreamStatus, backfilling: false };
      this.scheduleStateEmit();
    });

    this.hydrator.on('profile', ({ did, author }) => {
      const updated = this.store.updateAuthor(did, author);
      if (updated.length > 0) {
        this.emit('profile', { did, author });
      }
    });
  }

  async start(): Promise<void> {
    // ライブ接続を先に張り、過去の取り込みは別接続で並行して行う。
    // こうしないと、追いつくまでの数十秒間ライブ投稿が画面に出ない。
    this.jetstream.start();
    if (this.config.jetstream.startupBackfillMinutes > 0) {
      this.jetstreamStatus = { ...this.jetstreamStatus, backfilling: true };
      this.backfill.start();
    }
    this.modLists.start();
  }

  async stop(): Promise<void> {
    this.modLists.stop();
    this.backfill.stop();
    this.jetstream.stop();
    this.hydrator.stop();
    if (this.stateEmitTimer) {
      clearTimeout(this.stateEmitTimer);
      this.stateEmitTimer = null;
    }
  }

  getState(): WallState {
    return {
      hashtags: this.config.event.hashtags,
      terms: this.config.event.terms,
      eventTitle: this.config.event.title,
      eventSubtitle: this.config.event.subtitle,
      paused: this.paused,
      moderationMode: this.config.moderation.mode,
      jetstream: { ...this.jetstreamStatus, cursor: this.jetstream.cursor },
      stats: this.store.getStats(),
    };
  }

  getRecent(limit: number): WallPost[] {
    return this.store.getRecent(limit);
  }

  getPending(limit: number): WallPost[] {
    return this.store.getPending(limit);
  }

  setPaused(paused: boolean): WallState {
    this.paused = paused;
    this.scheduleStateEmit();
    return this.getState();
  }

  hide(uri: string): boolean {
    this.stashHidden(uri);
    this.rememberHidden(uri);
    const removed = this.store.remove(uri, 'hidden');
    if (removed) {
      this.emit('remove', { uri, reason: 'hidden' });
      this.scheduleStateEmit();
    }
    return removed;
  }

  unhide(uri: string): boolean {
    const post = this.hiddenPosts.get(uri);
    if (!post) return false;
    this.hiddenPosts.delete(uri);
    this.hiddenUris.delete(uri);
    this.restore(post);
    this.scheduleStateEmit();
    return true;
  }

  getHidden(limit: number): WallPost[] {
    const n = Math.max(0, limit);
    return [...this.hiddenPosts.values()].sort((a, b) => b.timeUs - a.timeUs).slice(0, n);
  }

  getBlockedActors(): string[] {
    return [...this.config.moderation.blockActors];
  }

  unblockActor(actor: string): number {
    const needle = actor.toLowerCase();
    const idx = this.config.moderation.blockActors.indexOf(needle);
    if (idx >= 0) this.config.moderation.blockActors.splice(idx, 1);

    // ブロック時に取り下げた投稿を戻す。
    let count = 0;
    for (const post of [...this.hiddenPosts.values()]) {
      if (post.did.toLowerCase() !== needle && post.author.handle.toLowerCase() !== needle) continue;
      this.hiddenPosts.delete(post.uri);
      this.hiddenUris.delete(post.uri);
      this.restore(post);
      count += 1;
    }
    this.scheduleStateEmit();
    return count;
  }

  /**
   * 復元した投稿を表示へ戻す。
   * 既に表示中の最新より古ければ history として下へ積み、
   * 最新であれば通常の新着として上へ差し込む。
   */
  private restore(post: WallPost): void {
    const newest = this.store.getRecent(1)[0];
    if (newest && newest.timeUs > post.timeUs) {
      this.store.addHistory([post]);
      if (!this.paused) this.emit('history', [post]);
      return;
    }
    this.store.add(post);
    if (!this.paused) this.emit('post', post);
  }

  /** 非表示にする前に投稿の実体を控える。 */
  private stashHidden(uri: string): void {
    const post = this.store.get(uri);
    if (!post) return;
    this.hiddenPosts.set(uri, post);
    if (this.hiddenPosts.size > HIDDEN_URI_LIMIT) {
      const oldest = this.hiddenPosts.keys().next();
      if (!oldest.done) this.hiddenPosts.delete(oldest.value);
    }
  }

  approve(uri: string): boolean {
    const post = this.store.promotePending(uri);
    if (!post) return false;
    if (!this.paused) {
      this.emit('post', post);
    }
    this.scheduleStateEmit();
    return true;
  }

  blockActor(actor: string): number {
    const needle = actor.toLowerCase();
    this.config.moderation.blockActors.push(needle);

    const targets = [...this.store.getRecent(Number.MAX_SAFE_INTEGER), ...this.store.getPending(Number.MAX_SAFE_INTEGER)];
    let count = 0;
    for (const post of targets) {
      if (post.did.toLowerCase() === needle || post.author.handle.toLowerCase() === needle) {
        this.hiddenPosts.set(post.uri, post);
        this.rememberHidden(post.uri);
        if (this.store.remove(post.uri, 'hidden')) {
          this.emit('remove', { uri: post.uri, reason: 'hidden' });
          count += 1;
        }
      }
    }
    if (count > 0) this.scheduleStateEmit();
    return count;
  }

  clear(): void {
    const targets = [...this.store.getRecent(Number.MAX_SAFE_INTEGER), ...this.store.getPending(Number.MAX_SAFE_INTEGER)];
    this.store.clear();
    for (const post of targets) {
      this.emit('remove', { uri: post.uri, reason: 'cleared' });
    }
    this.scheduleStateEmit();
  }

  private handleCommit(event: JetstreamEvent, source: 'live' | 'backfill'): void {
    const commit = event.commit;
    if (!commit || commit.collection !== POST_COLLECTION) return;

    this.jetstreamStatus = { ...this.jetstreamStatus, lastEventAt: Date.now() };

    const uri = `at://${event.did}/app.bsky.feed.post/${commit.rkey}`;

    if (commit.operation === 'delete') {
      // 取り込み待ちのバッファから取り除く。削除済みの投稿を画面へ出さないため。
      if (this.backfillBuffer.delete(uri)) {
        this.backfillDroppedCount += 1;
      } else if (source === 'live' && this.jetstreamStatus.backfilling) {
        // 再生がまだこの投稿の作成に到達していない可能性があるため覚えておく。
        this.rememberBackfillDeleted(uri);
      }
      if (this.store.remove(uri, 'deleted')) {
        this.emit('remove', { uri, reason: 'deleted' });
        this.scheduleStateEmit();
      }
      return;
    }

    if (commit.operation !== 'create') return;
    const record = commit.record;
    if (!record) return;
    if (this.store.has(uri)) return; // 同一 uri の重複受信を無視する。
    if (this.hiddenUris.has(uri)) return; // 運営が非表示にした投稿は再配信されても復活させない。
    if (this.backfillBuffer.has(uri)) return; // 取り込み待ちに既にある。
    if (source === 'backfill' && this.backfillDeleted.has(uri)) return; // 既に削除が確認されている。

    const matchedTags = matchHashtags(record, this.config.event.normalizedHashtags);
    const matchedKeywords = matchKeywords(record, this.config.event.terms);
    if (matchedTags.length === 0 && matchedKeywords.length === 0) return;

    this.store.recordMatched();

    // モデレーションリストに載っているアカウントは表示しない。
    if (this.modLists.isBlocked(event.did)) {
      this.store.recordRejected();
      return;
    }

    const author = this.hydrator.resolve(event.did, event.did);
    const modResult = evaluate(record, { did: event.did, handle: author.handle }, this.config.moderation);
    if (!modResult.ok) {
      this.store.recordRejected();
      return;
    }

    const wallPost = mapToWallPost({
      did: event.did,
      rkey: commit.rkey,
      cid: commit.cid ?? '',
      record,
      timeUs: event.time_us,
      matchedTags,
      matchedKeywords,
      showImages: this.config.display.showImages,
      author,
    });

    // バックフィル分は取り込み完了までバッファに溜め、削除済みを除いてからまとめて出す。
    if (source === 'backfill') {
      this.backfillBuffer.set(uri, wallPost);
      return;
    }

    // ハッシュタグが付いていない投稿は、投稿者がイベントを意識していない可能性がある。
    // 会場スクリーンに無関係な第三者の投稿を出さないよう、既定では確認を挟む。
    const keywordOnly = matchedTags.length === 0 && matchedKeywords.length > 0;
    const needsApproval =
      this.config.moderation.mode === 'approve' ||
      (keywordOnly && this.config.moderation.keywordRequireApproval);

    if (needsApproval) {
      const pendingPost: WallPost = { ...wallPost, status: 'pending' };
      this.store.addPending(pendingPost);
      if (!this.paused) {
        this.emit('pending', pendingPost);
      }
    } else {
      this.store.add(wallPost);
      if (!this.paused) {
        this.emit('post', wallPost);
      }
    }
    this.scheduleStateEmit();
  }

  /**
   * バックフィルで溜めた投稿を確定させる。
   * 再生中に削除コミットが来たもの、運営が非表示にしたもの、
   * 既にライブ側で表示済みのものを除いて、新しい順で一度に送出する。
   */
  private flushBackfill(): void {
    const survivors: WallPost[] = [];
    let dropped = 0;
    for (const [uri, post] of this.backfillBuffer) {
      if (this.backfillDeleted.has(uri) || this.hiddenUris.has(uri)) {
        dropped += 1;
        continue;
      }
      if (this.store.has(uri)) continue;
      survivors.push(post);
    }
    log.info(
      `バックフィル確定: ${survivors.length} 件を表示 ` +
        `(削除済み・非表示のため除外: ${dropped + this.backfillDroppedCount} 件)`
    );
    this.backfillDroppedCount = 0;
    this.backfillBuffer = new Map();
    this.backfillDeleted = new Set();

    if (survivors.length === 0) return;

    // 新しい順。会場モニターはこの順で既存カードの下へ積む。
    survivors.sort((a, b) => b.timeUs - a.timeUs);

    if (this.config.moderation.mode === 'approve') {
      // 承認モードでは過去分も承認を経てから表示する。
      for (const post of survivors) {
        const pendingPost: WallPost = { ...post, status: 'pending' };
        this.store.addPending(pendingPost);
        if (!this.paused) this.emit('pending', pendingPost);
      }
      this.scheduleStateEmit();
      return;
    }

    this.store.addHistory(survivors);
    if (!this.paused) {
      this.emit('history', survivors);
    }
    this.scheduleStateEmit();
  }

  /** ライブ側で観測した削除を記録する。無制限に増えないよう古いものから捨てる。 */
  private rememberBackfillDeleted(uri: string): void {
    this.backfillDeleted.add(uri);
    if (this.backfillDeleted.size > BACKFILL_DELETED_LIMIT) {
      const oldest = this.backfillDeleted.values().next();
      if (!oldest.done) this.backfillDeleted.delete(oldest.value);
    }
  }

  setTerms(input: { value: string; type: WatchTerm['type'] }[]): WatchTerm[] {
    const terms = buildTerms(input).slice(0, MAX_TERMS);
    // 監視語を空にすると何も拾えなくなる。呼び出し側の検証漏れに備え、
    // ここでも空への差し替えは拒否して現状を維持する。
    if (terms.length === 0) {
      log.warn('監視語を空にしようとしたため無視しました');
      return this.config.event.terms;
    }
    this.config.event.terms = terms;

    const hashtags = terms.filter((t) => t.type === 'hashtag');
    this.config.event.hashtags = hashtags.map((t) => t.value);
    this.config.event.normalizedHashtags = hashtags.map((t) => t.normalized);

    log.info('監視語を変更しました', {
      hashtags: hashtags.map((t) => t.value),
      keywords: terms.filter((t) => t.type === 'keyword').map((t) => t.value),
    });
    this.scheduleStateEmit();
    return terms;
  }

  getTerms(): WatchTerm[] {
    return this.config.event.terms;
  }

  getJetstreamHosts(): string[] {
    return this.jetstream.availableHosts;
  }

  switchJetstreamHost(host: string): boolean {
    const ok = this.jetstream.switchHost(host);
    if (ok) {
      this.jetstreamStatus = { ...this.jetstreamStatus, connected: false, host };
      this.scheduleStateEmit();
    }
    return ok;
  }

  getModLists(): ModListInfo[] {
    return this.modLists.list();
  }

  async subscribeModList(uri: string): Promise<{ info: ModListInfo; removed: number }> {
    const { info, dids } = await this.modLists.subscribe(uri);
    // 既に表示されている掲載アカウントの投稿を取り下げる。
    const blocked = new Set(dids);
    let removed = 0;
    const targets = [
      ...this.store.getRecent(Number.MAX_SAFE_INTEGER),
      ...this.store.getPending(Number.MAX_SAFE_INTEGER),
    ];
    for (const post of targets) {
      if (!blocked.has(post.did)) continue;
      this.hiddenPosts.set(post.uri, post);
      if (this.store.remove(post.uri, 'hidden')) {
        this.emit('remove', { uri: post.uri, reason: 'hidden' });
        removed += 1;
      }
    }
    if (removed > 0) this.scheduleStateEmit();
    return { info, removed };
  }

  unsubscribeModList(uri: string): boolean {
    if (!this.modLists.has(uri)) return false;
    this.modLists.unsubscribe(uri);
    this.scheduleStateEmit();
    return true;
  }

  /** 非表示 uri を記録する。無制限に増えないよう古いものから捨てる。 */
  private rememberHidden(uri: string): void {
    this.hiddenUris.add(uri);
    if (this.hiddenUris.size > HIDDEN_URI_LIMIT) {
      const oldest = this.hiddenUris.values().next();
      if (!oldest.done) this.hiddenUris.delete(oldest.value);
    }
  }

  private scheduleStateEmit(): void {
    if (this.stateEmitTimer) {
      this.stateEmitPending = true;
      return;
    }
    this.emit('state', this.getState());
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      if (this.stateEmitPending) {
        this.stateEmitPending = false;
        this.emit('state', this.getState());
      }
    }, STATE_THROTTLE_MS);
  }
}
