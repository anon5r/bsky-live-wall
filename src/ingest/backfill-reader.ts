/**
 * 起動時の過去投稿取り込み専用の一回限りの Jetstream 接続。
 *
 * ライブ接続 (JetstreamClient) とは別の WebSocket を使う。
 * 1 本の接続で過去から再生すると、現在に追いつくまで新着投稿が届かず
 * 会場モニターへの反映が数十秒遅れるため、経路を分離している。
 * 現在時刻に追いついた時点で自ら接続を閉じ、`done` を発火して役目を終える。
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AppConfig } from '../shared/config.js';
import type { JetstreamEvent } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('backfill');

const WANTED_COLLECTION = 'app.bsky.feed.post';
/** 現在時刻とこの差以内まで再生できたら追いついたとみなす。 */
const CATCH_UP_THRESHOLD_US = 5_000_000;
/** 無通信でこの時間が過ぎたら打ち切る。 */
const IDLE_TIMEOUT_MS = 30_000;
/** 想定外に長引いた場合の打ち切り上限。 */
const HARD_TIMEOUT_MS = 10 * 60_000;

export interface BackfillReaderEvents {
  commit: (event: JetstreamEvent) => void;
  /** 取り込み終了。caughtUp が false なら途中で打ち切られている。 */
  done: (info: { caughtUp: boolean; scanned: number; elapsedMs: number }) => void;
}

export class BackfillReader extends EventEmitter {
  private readonly host: string;
  private readonly minutes: number;

  private ws: WebSocket | null = null;
  private finished = false;
  private scanned = 0;
  private startedAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;

  declare on: <K extends keyof BackfillReaderEvents>(
    event: K,
    listener: BackfillReaderEvents[K]
  ) => this;

  declare emit: <K extends keyof BackfillReaderEvents>(
    event: K,
    ...args: Parameters<BackfillReaderEvents[K]>
  ) => boolean;

  constructor(config: AppConfig['jetstream']) {
    super();
    this.host = config.hosts[0] ?? 'jetstream2.us-east.bsky.network';
    this.minutes = config.startupBackfillMinutes;
  }

  start(): void {
    if (this.minutes <= 0) {
      this.finish(true);
      return;
    }
    this.startedAt = Date.now();
    const cursor = (Date.now() - this.minutes * 60_000) * 1_000;
    const url = `wss://${this.host}/subscribe?wantedCollections=${WANTED_COLLECTION}&cursor=${cursor}`;
    log.info(`過去 ${this.minutes} 分の取り込みを開始します (ライブ受信と並行)`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      log.warn('バックフィル接続に失敗しました', err);
      this.finish(false);
      return;
    }
    this.ws = socket;

    socket.on('message', (data: WebSocket.RawData) => {
      this.armIdleTimer();
      this.handleMessage(data);
    });
    socket.on('error', (err) => {
      log.warn('バックフィル中にエラーが発生しました', err);
      this.finish(false);
    });
    socket.on('close', () => {
      if (!this.finished) this.finish(false);
    });

    this.armIdleTimer();
    this.hardTimer = setTimeout(() => {
      log.warn('バックフィルが時間内に完了しなかったため打ち切ります');
      this.finish(false);
    }, HARD_TIMEOUT_MS);
    this.hardTimer.unref();
  }

  stop(): void {
    if (!this.finished) this.finish(false);
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: JetstreamEvent;
    try {
      event = JSON.parse(data.toString()) as JetstreamEvent;
    } catch {
      return;
    }
    this.scanned++;
    this.emit('commit', event);

    // 現在時刻に追いついたら終了する。
    if (typeof event.time_us === 'number' && Date.now() * 1_000 - event.time_us < CATCH_UP_THRESHOLD_US) {
      this.finish(true);
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.warn('バックフィルが無通信のため打ち切ります');
      this.finish(false);
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private finish(caughtUp: boolean): void {
    if (this.finished) return;
    this.finished = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.idleTimer = null;
    this.hardTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // 既に閉じている場合は無視する。
      }
      this.ws = null;
    }
    const elapsedMs = this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
    if (this.minutes > 0) {
      log.info(
        caughtUp
          ? `バックフィル完了: ${this.minutes} 分を ${(elapsedMs / 1000).toFixed(1)} 秒で取り込みました`
          : 'バックフィルは完了せずに終了しました (ライブ受信は継続します)'
      );
    }
    this.emit('done', { caughtUp, scanned: this.scanned, elapsedMs });
  }
}
