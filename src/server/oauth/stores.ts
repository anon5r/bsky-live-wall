/**
 * OAuth の一時状態とセッションの保存先。
 *
 * イベント用途では認可コードの往復 (数分) の間だけ保持できれば足りるため、
 * メモリ上に置く。プロセスを再起動すると認可途中の状態は失われるが、
 * 利用者がログインし直せば済む。
 */
import type { NodeSavedSession, NodeSavedState } from '@atproto/oauth-client-node';

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** SimpleStore の最小実装。TTL 付きで、期限切れは読み出し時に破棄する。 */
class MemoryStore<V> {
  private readonly map = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly limit: number
  ) {}

  async get(key: string): Promise<V | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: V): Promise<void> {
    this.prune();
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(key);
    }
    // 期限切れを掃除しても上限を超える場合は、古いものから捨てる。
    while (this.map.size >= this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}

/** 認可リクエストの一時状態。往復の間だけ持てばよい。 */
export function createStateStore(): MemoryStore<NodeSavedState> {
  return new MemoryStore<NodeSavedState>(10 * 60_000, 500);
}

/**
 * OAuth セッション。
 * 本システムは「誰がログインしたか」を知るためだけに OAuth を使い、
 * 利用者に代わって API を呼ぶことはないため、長期保持する必要はない。
 */
export function createSessionStore(): MemoryStore<NodeSavedSession> {
  return new MemoryStore<NodeSavedSession>(24 * 3_600_000, 200);
}
