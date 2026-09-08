/**
 * DID からプロフィール (表示名 / ハンドル / アバター) を解決する。
 * 公開 AppView (認証不要) を使い、バッチ + TTL キャッシュで負荷を抑える。
 * 投稿処理をブロックしないよう、失敗は握りつぶしてバックグラウンドでリトライする。
 */
import { EventEmitter } from 'node:events';
import { AtpAgent } from '@atproto/api';
import type { AppConfig } from '../shared/config.js';
import type { WallAuthor } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('profile-hydrator');

const BATCH_MAX = 25;
const BATCH_DEBOUNCE_MS = 50;
const MAX_CACHE_ENTRIES = 2000;
const RETRY_DELAY_MS = 5_000;

interface CacheEntry {
  author: WallAuthor;
  expiresAt: number;
}

export interface ProfileHydratorEvents {
  profile: (payload: { did: string; author: WallAuthor }) => void;
}

export class ProfileHydrator extends EventEmitter {
  private readonly agent: AtpAgent;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queue = new Set<string>();
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(config: AppConfig) {
    super();
    this.agent = new AtpAgent({ service: config.appview.url });
    this.ttlMs = config.appview.profileCacheTtlSec * 1000;
  }

  declare on: <K extends keyof ProfileHydratorEvents>(
    event: K,
    listener: ProfileHydratorEvents[K]
  ) => this;

  declare emit: <K extends keyof ProfileHydratorEvents>(
    event: K,
    ...args: Parameters<ProfileHydratorEvents[K]>
  ) => boolean;

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** キャッシュがあれば即返す。無ければプレースホルダを返しつつバックグラウンドで解決する。 */
  resolve(did: string, fallbackHandle: string): WallAuthor {
    const cached = this.getFresh(did);
    if (cached) return cached;
    this.enqueue(did);
    return { did, handle: fallbackHandle };
  }

  private getFresh(did: string): WallAuthor | null {
    const entry = this.cache.get(did);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(did);
      return null;
    }
    return entry.author;
  }

  private enqueue(did: string): void {
    if (this.stopped) return;
    if (this.inFlight.has(did)) return;
    this.queue.add(did);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), BATCH_DEBOUNCE_MS);
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.stopped || this.queue.size === 0) return;

    const batch = [...this.queue].slice(0, BATCH_MAX);
    for (const did of batch) {
      this.queue.delete(did);
      this.inFlight.add(did);
    }
    if (this.queue.size > 0) {
      // 残りがあれば続けてスケジュールする。
      this.timer = setTimeout(() => this.flush(), BATCH_DEBOUNCE_MS);
    }

    void this.fetchBatch(batch);
  }

  private async fetchBatch(dids: string[]): Promise<void> {
    try {
      const res = await this.agent.app.bsky.actor.getProfiles({ actors: dids });
      const resolved = new Set<string>();
      for (const profile of res.data.profiles) {
        const author: WallAuthor = {
          did: profile.did,
          handle: profile.handle,
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          ...(profile.avatar ? { avatar: profile.avatar } : {}),
        };
        this.cache.set(profile.did, { author, expiresAt: Date.now() + this.ttlMs });
        this.evictIfNeeded();
        resolved.add(profile.did);
        this.emit('profile', { did: profile.did, author });
      }
      for (const did of dids) {
        this.inFlight.delete(did);
        if (!resolved.has(did)) {
          // AppView 側に存在しない (削除済みアカウント等)。短時間キャッシュして無限リトライを防ぐ。
          this.cache.set(did, {
            author: { did, handle: did },
            expiresAt: Date.now() + RETRY_DELAY_MS,
          });
        }
      }
    } catch (err) {
      log.warn('プロフィール取得に失敗。後でリトライする', err);
      for (const did of dids) {
        this.inFlight.delete(did);
      }
      if (!this.stopped) {
        setTimeout(() => {
          for (const did of dids) this.enqueue(did);
        }, RETRY_DELAY_MS);
      }
    }
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }
}
