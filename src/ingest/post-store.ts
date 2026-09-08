/**
 * WallPost のリングバッファ。表示中 (visible) と承認待ち (pending) を分けて保持する。
 */
import type { WallPost, WallPostStatus, WallStats } from '../shared/types.js';

/** ユニーク投稿者数を数える際の Set 上限。超過分は古いものを追跡しない (概算に倒す)。 */
const MAX_TRACKED_AUTHORS = 20_000;

interface StoreOptions {
  size: number;
  pendingSize: number;
}

export class PostStore {
  private readonly size: number;
  private readonly pendingSize: number;

  /** 表示中の投稿。挿入順 (古い→新しい)。 */
  private readonly order: string[] = [];
  private readonly byUri = new Map<string, WallPost>();

  /** 承認待ちの投稿。 */
  private readonly pendingOrder: string[] = [];
  private readonly pendingByUri = new Map<string, WallPost>();

  private readonly authors = new Set<string>();

  private stats: WallStats = {
    matched: 0,
    displayed: 0,
    rejected: 0,
    authors: 0,
    startedAt: Date.now(),
  };

  constructor(options: StoreOptions) {
    this.size = Math.max(1, options.size);
    this.pendingSize = Math.max(1, options.pendingSize);
  }

  /** 重複判定用。表示中・承認待ちいずれかに存在すればユニーク判定される。 */
  has(uri: string): boolean {
    return this.byUri.has(uri) || this.pendingByUri.has(uri);
  }

  /** 表示中・承認待ちから 1 件取り出す。存在しなければ undefined。 */
  get(uri: string): WallPost | undefined {
    return this.byUri.get(uri) ?? this.pendingByUri.get(uri);
  }

  /** 表示対象として追加する。上限超過時は最古のものを追い出す。 */
  add(post: WallPost): void {
    if (this.byUri.has(post.uri)) return;
    this.byUri.set(post.uri, post);
    this.order.push(post.uri);
    this.trackAuthor(post.did);
    this.stats.displayed += 1;
    while (this.order.length > this.size) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.byUri.delete(oldest);
    }
  }

  /**
   * 過去に遡って取得した投稿をまとめて追加する。
   * 挿入順ではなく投稿時刻順に並べ直すため、ライブ投稿より下に正しく並ぶ。
   */
  addHistory(posts: WallPost[]): void {
    let added = false;
    for (const post of posts) {
      if (this.byUri.has(post.uri)) continue;
      this.byUri.set(post.uri, post);
      this.order.push(post.uri);
      this.trackAuthor(post.did);
      this.stats.displayed += 1;
      added = true;
    }
    if (!added) return;

    // order は「古い→新しい」を前提に getRecent が末尾から取り出すため、
    // 過去分を足したあとは投稿時刻で並べ直す必要がある。
    this.order.sort((a, b) => {
      const pa = this.byUri.get(a);
      const pb = this.byUri.get(b);
      return (pa?.timeUs ?? 0) - (pb?.timeUs ?? 0);
    });

    while (this.order.length > this.size) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.byUri.delete(oldest);
    }
  }

  /** 承認待ちとして追加する。 */
  addPending(post: WallPost): void {
    if (this.pendingByUri.has(post.uri)) return;
    this.pendingByUri.set(post.uri, post);
    this.pendingOrder.push(post.uri);
    this.trackAuthor(post.did);
    while (this.pendingOrder.length > this.pendingSize) {
      const oldest = this.pendingOrder.shift();
      if (oldest !== undefined) this.pendingByUri.delete(oldest);
    }
  }

  /** 承認待ちから表示中へ昇格させる。成功時にその投稿を返す。 */
  promotePending(uri: string): WallPost | null {
    const post = this.pendingByUri.get(uri);
    if (!post) return null;
    this.removePendingOnly(uri);
    const visible: WallPost = { ...post, status: 'visible' };
    this.add(visible);
    return visible;
  }

  private removePendingOnly(uri: string): void {
    if (!this.pendingByUri.delete(uri)) return;
    const idx = this.pendingOrder.indexOf(uri);
    if (idx >= 0) this.pendingOrder.splice(idx, 1);
  }

  /** 表示中・承認待ちの両方から削除する。存在した場合 true。 */
  remove(uri: string, reason: 'deleted' | 'hidden' | 'cleared'): boolean {
    let removed = false;
    if (this.byUri.delete(uri)) {
      const idx = this.order.indexOf(uri);
      if (idx >= 0) this.order.splice(idx, 1);
      removed = true;

      // 投稿者が消したものと運営が伏せたものは、表示実績から差し引く。
      // 画面の全消去は「表示した事実」を取り消すものではないので数えたままにする。
      if (reason === 'deleted' || reason === 'hidden') {
        this.stats.displayed = Math.max(0, this.stats.displayed - 1);
      }
    }
    if (this.pendingByUri.delete(uri)) {
      const idx = this.pendingOrder.indexOf(uri);
      if (idx >= 0) this.pendingOrder.splice(idx, 1);
      removed = true;
    }
    return removed;
  }

  /** 投稿者の全投稿 (表示中+承認待ち) の uri 一覧を返す。 */
  urisByActor(did: string): string[] {
    const out: string[] = [];
    for (const uri of this.order) {
      const post = this.byUri.get(uri);
      if (post?.did === did) out.push(uri);
    }
    for (const uri of this.pendingOrder) {
      const post = this.pendingByUri.get(uri);
      if (post?.did === did) out.push(uri);
    }
    return out;
  }

  getRecent(limit: number): WallPost[] {
    const n = Math.max(0, limit);
    const uris = this.order.slice(Math.max(0, this.order.length - n));
    return uris
      .map((u) => this.byUri.get(u))
      .filter((p): p is WallPost => p !== undefined)
      .reverse();
  }

  getPending(limit: number): WallPost[] {
    const n = Math.max(0, limit);
    const uris = this.pendingOrder.slice(Math.max(0, this.pendingOrder.length - n));
    return uris
      .map((u) => this.pendingByUri.get(u))
      .filter((p): p is WallPost => p !== undefined)
      .reverse();
  }

  updateAuthor(did: string, patch: Partial<WallPost['author']>): WallPost[] {
    const updated: WallPost[] = [];
    for (const uri of [...this.order, ...this.pendingOrder]) {
      const post = this.byUri.get(uri) ?? this.pendingByUri.get(uri);
      if (post && post.did === did) {
        post.author = { ...post.author, ...patch };
        updated.push(post);
      }
    }
    return updated;
  }

  clear(): void {
    this.order.length = 0;
    this.byUri.clear();
    this.pendingOrder.length = 0;
    this.pendingByUri.clear();
  }

  recordMatched(): void {
    this.stats.matched += 1;
  }

  recordRejected(): void {
    this.stats.rejected += 1;
  }

  getStats(): WallStats {
    return { ...this.stats, authors: this.authors.size };
  }

  getStatusFor(uri: string): WallPostStatus | null {
    if (this.byUri.has(uri)) return 'visible';
    if (this.pendingByUri.has(uri)) return 'pending';
    return null;
  }

  private trackAuthor(did: string): void {
    if (this.authors.size < MAX_TRACKED_AUTHORS) {
      this.authors.add(did);
    }
  }
}
