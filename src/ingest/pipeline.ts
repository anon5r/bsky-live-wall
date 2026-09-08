/**
 * Jetstream 受信からモデレーション・プロフィール解決・PostStore 格納までを束ね、
 * WallSource として server 層へ公開する。
 */
import { EventEmitter } from 'node:events';
import type { AppConfig } from '../shared/config.js';
import type {
  JetstreamEvent,
  JetstreamStatus,
  WallPost,
  WallState,
} from '../shared/types.js';
import type { WallSource, WallSourceEvents } from '../shared/contracts.js';
import { createLogger } from '../shared/logger.js';
import { JetstreamClient } from './jetstream-client.js';
import { BackfillReader } from './backfill-reader.js';
import { matchHashtags } from './hashtag-matcher.js';
import { evaluate } from './moderator.js';
import { mapToWallPost } from './post-mapper.js';
import { ProfileHydrator } from './profile-hydrator.js';
import { PostStore } from './post-store.js';

const log = createLogger('pipeline');

const STATE_THROTTLE_MS = 1000;
const POST_COLLECTION = 'app.bsky.feed.post';

export class WallPipeline extends EventEmitter implements WallSource {
  private readonly config: AppConfig;
  private readonly jetstream: JetstreamClient;
  private readonly backfill: BackfillReader;
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
    this.jetstream.on('commit', (event) => this.handleCommit(event));

    // バックフィルはライブ受信と並行して走る。取り込み口は同じで、
    // 重複した投稿は PostStore が uri で弾く。
    this.backfill.on('commit', (event) => this.handleCommit(event));
    this.backfill.on('done', () => {
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
  }

  async stop(): Promise<void> {
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
    const removed = this.store.remove(uri, 'hidden');
    if (removed) {
      this.emit('remove', { uri, reason: 'hidden' });
      this.scheduleStateEmit();
    }
    return removed;
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

  private handleCommit(event: JetstreamEvent): void {
    const commit = event.commit;
    if (!commit || commit.collection !== POST_COLLECTION) return;

    this.jetstreamStatus = { ...this.jetstreamStatus, lastEventAt: Date.now() };

    const uri = `at://${event.did}/app.bsky.feed.post/${commit.rkey}`;

    if (commit.operation === 'delete') {
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

    const matchedTags = matchHashtags(record, this.config.event.normalizedHashtags);
    if (matchedTags.length === 0) return;

    this.store.recordMatched();

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
      showImages: this.config.display.showImages,
      author,
    });

    if (this.config.moderation.mode === 'approve') {
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
