/**
 * AT Protocol のモデレーションリストを購読し、掲載アカウントを非表示にする。
 *
 * リストは公開データのため認証なしで取得できる (実測確認済み)。
 * リストは運用中にも編集されるため、定期的に取り直す。
 */
import type { AppConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import type { ModListInfo } from '../shared/types.js';

const log = createLogger('modlist');

/** リストの取り直し間隔。イベント中の追加を反映するため短めにする。 */
const REFRESH_INTERVAL_MS = 5 * 60_000;
/** 1 回の取得件数。API の上限に合わせる。 */
const PAGE_LIMIT = 100;
/** 1 リストあたりの取得上限。巨大なリストで無限に回らないようにする。 */
const MAX_MEMBERS = 20_000;

export type { ModListInfo };

interface Subscription extends ModListInfo {
  dids: Set<string>;
}

export class ModListManager {
  private readonly subscriptions = new Map<string, Subscription>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: AppConfig) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** この DID がいずれかの購読リストに載っているか。投稿ごとに呼ばれるので O(1) にする。 */
  isBlocked(did: string): boolean {
    for (const sub of this.subscriptions.values()) {
      if (sub.dids.has(did)) return true;
    }
    return false;
  }

  list(): ModListInfo[] {
    return [...this.subscriptions.values()].map(({ dids: _dids, ...info }) => info);
  }

  has(uri: string): boolean {
    return this.subscriptions.has(uri);
  }

  /** 購読を追加し、初回の取得を行う。取得したメンバーの DID を返す。 */
  async subscribe(uri: string): Promise<{ info: ModListInfo; dids: string[] }> {
    const sub: Subscription = {
      uri,
      name: uri,
      purpose: '',
      memberCount: 0,
      lastFetchedAt: null,
      dids: new Set(),
    };
    this.subscriptions.set(uri, sub);
    await this.refresh(sub);
    const { dids, ...info } = sub;
    return { info, dids: [...dids] };
  }

  /** 購読を解除する。解除されたリストにのみ載っていた DID を返す。 */
  unsubscribe(uri: string): string[] {
    const sub = this.subscriptions.get(uri);
    if (!sub) return [];
    this.subscriptions.delete(uri);
    // 他のリストにも載っている DID はブロックしたままにする。
    return [...sub.dids].filter((did) => !this.isBlocked(did));
  }

  async refreshAll(): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      await this.refresh(sub);
    }
  }

  private async refresh(sub: Subscription): Promise<void> {
    const dids = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const params = new URLSearchParams({ list: sub.uri, limit: String(PAGE_LIMIT) });
        if (cursor) params.set('cursor', cursor);
        const res = await fetch(`${this.config.appview.url}/xrpc/app.bsky.graph.getList?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          list?: { name?: string; purpose?: string };
          items?: { subject?: { did?: string } }[];
          cursor?: string;
        };
        if (data.list) {
          sub.name = data.list.name ?? sub.uri;
          sub.purpose = data.list.purpose ?? '';
        }
        for (const item of data.items ?? []) {
          if (item.subject?.did) dids.add(item.subject.did);
        }
        cursor = data.cursor;
      } while (cursor && dids.size < MAX_MEMBERS);

      sub.dids = dids;
      sub.memberCount = dids.size;
      sub.lastFetchedAt = Date.now();
      delete sub.error;
      log.info(`モデレーションリストを読み込みました: ${sub.name} (${dids.size} 件)`);
    } catch (err) {
      // 取得に失敗しても、前回読み込んだ内容をそのまま使い続ける。
      // イベント中にリスト取得が失敗しただけで荒らし対策が外れるのは避ける。
      sub.error = err instanceof Error ? err.message : String(err);
      log.warn(`モデレーションリストの取得に失敗しました: ${sub.uri}`, err);
    }
  }
}
