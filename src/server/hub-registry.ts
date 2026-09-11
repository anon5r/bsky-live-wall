/**
 * ウォールごとの SSE 接続をまとめる。
 * ウォールが違えば流す投稿も違うため、接続はウォール単位で分ける。
 *
 * multi モードではウォール ID がテナントをまたいで衝突し得る
 * (各テナントの既定ウォール ID は等しく `main` になる) ため、
 * キーはテナント ID とウォール ID の組で作る。
 */
import { SseHub } from './sse-hub.js';

/** テナント内で一意な区切り文字。テナント ID / ウォール ID は正規化済みスラッグ (英数と `_-`) のため衝突しない。 */
function key(tenantId: string, wallId: string): string {
  return `${tenantId}/${wallId}`;
}

export class HubRegistry {
  private readonly hubs = new Map<string, SseHub>();

  /** 指定ウォールの Hub を取り出す (無ければ作る)。 */
  get(tenantId: string, wallId: string): SseHub {
    const k = key(tenantId, wallId);
    let hub = this.hubs.get(k);
    if (!hub) {
      hub = new SseHub();
      this.hubs.set(k, hub);
    }
    return hub;
  }

  /** 存在する Hub だけを返す。イベント中継で不要な Hub を作らないために使う。 */
  peek(tenantId: string, wallId: string): SseHub | undefined {
    return this.hubs.get(key(tenantId, wallId));
  }

  /** 全ウォールの接続数の合計。 */
  size(): number {
    let total = 0;
    for (const hub of this.hubs.values()) total += hub.size();
    return total;
  }

  /**
   * 指定テナントのうち、生きていないウォールへの接続を閉じる。
   * 他テナントの Hub には触れない (テナント ID をプレフィックスに使っているため)。
   */
  dropMissing(tenantId: string, aliveWallIds: Set<string>): void {
    const prefix = `${tenantId}/`;
    for (const k of [...this.hubs.keys()]) {
      if (!k.startsWith(prefix)) continue;
      const wallId = k.slice(prefix.length);
      if (!aliveWallIds.has(wallId)) this.drop(tenantId, wallId);
    }
  }

  /** ウォール削除時に接続を閉じる。 */
  drop(tenantId: string, wallId: string): void {
    const k = key(tenantId, wallId);
    const hub = this.hubs.get(k);
    if (!hub) return;
    hub.close();
    this.hubs.delete(k);
  }

  /** テナント削除時に、そのテナントの Hub をすべて閉じる。 */
  dropTenant(tenantId: string): void {
    const prefix = `${tenantId}/`;
    for (const k of [...this.hubs.keys()]) {
      if (!k.startsWith(prefix)) continue;
      const hub = this.hubs.get(k);
      hub?.close();
      this.hubs.delete(k);
    }
  }

  closeAll(): void {
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
