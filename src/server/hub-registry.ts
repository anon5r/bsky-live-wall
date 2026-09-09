/**
 * ウォールごとの SSE 接続をまとめる。
 * ウォールが違えば流す投稿も違うため、接続はウォール単位で分ける。
 */
import { SseHub } from './sse-hub.js';

export class HubRegistry {
  private readonly hubs = new Map<string, SseHub>();

  /** 指定ウォールの Hub を取り出す (無ければ作る)。 */
  get(wallId: string): SseHub {
    let hub = this.hubs.get(wallId);
    if (!hub) {
      hub = new SseHub();
      this.hubs.set(wallId, hub);
    }
    return hub;
  }

  /** 存在する Hub だけを返す。イベント中継で不要な Hub を作らないために使う。 */
  peek(wallId: string): SseHub | undefined {
    return this.hubs.get(wallId);
  }

  /** 全ウォールの接続数の合計。 */
  size(): number {
    let total = 0;
    for (const hub of this.hubs.values()) total += hub.size();
    return total;
  }

  /** 生きているウォール以外の接続を閉じる。ウォール削除時に呼ぶ。 */
  dropMissing(aliveWallIds: Set<string>): void {
    for (const id of [...this.hubs.keys()]) {
      if (!aliveWallIds.has(id)) this.drop(id);
    }
  }

  /** ウォール削除時に接続を閉じる。 */
  drop(wallId: string): void {
    const hub = this.hubs.get(wallId);
    if (!hub) return;
    hub.close();
    this.hubs.delete(wallId);
  }

  closeAll(): void {
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
