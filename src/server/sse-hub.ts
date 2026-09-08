/**
 * SSE (Server-Sent Events) クライアント接続管理。
 *
 * Fastify の `reply.raw` (Node の `http.ServerResponse`) に直接書き込む。
 * 接続ごとにリスナを張るのではなく、サーバー起動時に 1 回だけ WallSource の
 * イベントを購読し、ここでまとめて全クライアントへブロードキャストする設計を前提とする。
 */
import type { FastifyReply } from 'fastify';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('sse-hub');

/** ハートビート送出間隔 (ms)。FR-22 に合わせて 15 秒。 */
const PING_INTERVAL_MS = 15_000;

/** 書き込みバックプレッシャが解消しないまま許容する ping 回数。超えたら切断する。 */
const MAX_SLOW_PING_STRIKES = 3;

interface SseClient {
  id: number;
  reply: FastifyReply;
  /** back-pressure (write() が false を返した) が続いている回数 */
  slowStrikes: number;
  closed: boolean;
}

export class SseHub {
  private readonly clients = new Map<number, SseClient>();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  /** 新規 SSE 接続を登録する。ヘッダ送出とクリーンアップ配線もここで行う。 */
  add(reply: FastifyReply): number {
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 一部プロキシ/ブラウザのバッファリングを避けるための初期パディング。
    res.write(':ok\n\n');

    const id = this.nextId++;
    const client: SseClient = { id, reply, slowStrikes: 0, closed: false };
    this.clients.set(id, client);

    const cleanup = (): void => {
      this.remove(id);
    };
    res.on('close', cleanup);
    res.on('error', (err) => {
      logger.debug('SSE 接続でエラー', { id, err: String(err) });
      cleanup();
    });

    return id;
  }

  /** クライアントを除去し、接続を閉じる。 */
  remove(id: number): void {
    const client = this.clients.get(id);
    if (!client) return;
    if (client.closed) {
      this.clients.delete(id);
      return;
    }
    client.closed = true;
    this.clients.delete(id);
    try {
      if (!client.reply.raw.writableEnded) {
        client.reply.raw.end();
      }
    } catch {
      // 既に閉じている場合は無視する。
    }
  }

  /** 現在の接続数。 */
  size(): number {
    return this.clients.size;
  }

  /** 単一クライアントへ 1 イベントを書き込む。失敗時は除去する。 */
  private writeTo(client: SseClient, event: string, data: unknown): void {
    if (client.closed) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      const ok = client.reply.raw.write(payload);
      if (ok) {
        client.slowStrikes = 0;
      } else {
        client.slowStrikes += 1;
        if (client.slowStrikes >= MAX_SLOW_PING_STRIKES) {
          logger.warn('遅いクライアントを切断します', { id: client.id });
          this.remove(client.id);
        }
      }
    } catch (err) {
      logger.debug('SSE 書き込みに失敗、切断します', { id: client.id, err: String(err) });
      this.remove(client.id);
    }
  }

  /** 全接続へイベントをブロードキャストする。 */
  broadcast(event: string, data: unknown): void {
    for (const client of [...this.clients.values()]) {
      this.writeTo(client, event, data);
    }
  }

  /** 指定した 1 接続にのみイベントを送る (hello 送出などに使用)。 */
  sendTo(id: number, event: string, data: unknown): void {
    const client = this.clients.get(id);
    if (!client) return;
    this.writeTo(client, event, data);
  }

  private pingAll(): void {
    this.broadcast('ping', { t: Date.now() });
  }

  /** graceful shutdown 用。タイマー解除と全接続のクローズを行う。 */
  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const id of [...this.clients.keys()]) {
      this.remove(id);
    }
  }
}
