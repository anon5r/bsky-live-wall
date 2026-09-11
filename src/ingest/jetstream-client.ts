/**
 * Jetstream v2 への WebSocket 接続を管理する。
 * 指数バックオフ再接続、ホストフェイルオーバー、ハートビート監視を行う。
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AppConfig } from '../shared/config.js';
import type { JetstreamEvent } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('jetstream-client');

/** イベント/ハートビートが一定時間来なければ強制再接続する。 */
const WATCHDOG_TIMEOUT_MS = 60_000;
const WANTED_COLLECTION = 'app.bsky.feed.post';

/**
 * リスナを外したうえで WebSocket を閉じる。
 *
 * 接続確立前の WebSocket に close() / terminate() を呼ぶと、ws は
 * 例外ではなく非同期の 'error' イベントを出す。リスナを全部外した後だと
 * 受け手がおらず、Node が Unhandled 'error' event でプロセスごと落とす。
 * 空のハンドラを残してから閉じることでこれを防ぐ。
 */
function closeQuietly(ws: WebSocket): void {
  ws.removeAllListeners();
  ws.on('error', () => {
    // 閉じる過程のエラーは無視してよい。
  });
  try {
    ws.close();
  } catch {
    // 既に閉じている場合は無視する。
  }
}


export interface JetstreamClientEvents {
  open: (host: string) => void;
  close: (info: { host: string; code: number; reason: string }) => void;
  commit: (event: JetstreamEvent) => void;
  error: (err: Error) => void;
}

export class JetstreamClient extends EventEmitter {
  private readonly hosts: string[];
  private hostIndex = 0;
  private consecutiveFailures = 0;

  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly hostFailoverAfter: number;
  private readonly replayWindowSec: number;

  private ws: WebSocket | null = null;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;

  private lastTimeUs: number | null = null;

  declare on: <K extends keyof JetstreamClientEvents>(
    event: K,
    listener: JetstreamClientEvents[K]
  ) => this;

  declare off: <K extends keyof JetstreamClientEvents>(
    event: K,
    listener: JetstreamClientEvents[K]
  ) => this;

  declare emit: <K extends keyof JetstreamClientEvents>(
    event: K,
    ...args: Parameters<JetstreamClientEvents[K]>
  ) => boolean;

  constructor(config: AppConfig['jetstream']) {
    super();
    this.hosts = config.hosts.length > 0 ? config.hosts : ['jetstream2.us-east.bsky.network'];
    this.reconnectMinMs = config.reconnectMinMs;
    this.reconnectMaxMs = config.reconnectMaxMs;
    this.hostFailoverAfter = config.hostFailoverAfter;
    this.replayWindowSec = config.replayWindowSec;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    if (this.ws) {
      closeQuietly(this.ws);
      this.ws = null;
    }
  }

  get currentHost(): string {
    return this.hosts[this.hostIndex] ?? this.hosts[0] ?? '';
  }

  get cursor(): number | null {
    return this.lastTimeUs;
  }

  /** 接続候補のホスト一覧。 */
  get availableHosts(): string[] {
    return [...this.hosts];
  }

  /**
   * 接続先ホストを切り替える。
   * 現在のカーソルを保持したまま張り直すため、切り替え中の取りこぼしは
   * replayWindowSec の範囲で補填される。
   */
  switchHost(host: string): boolean {
    const index = this.hosts.indexOf(host);
    if (index < 0) return false;
    if (index === this.hostIndex && this.ws) {
      // 同じホストへの切り替えは、接続し直しとして扱う。
      log.info(`同一ホストへ再接続します: ${host}`);
    }
    this.hostIndex = index;
    this.consecutiveFailures = 0;
    this.reconnectAttempt = 0;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // 切断ハンドラによる自動再接続を止めてから閉じる。
      closeQuietly(this.ws);
      this.ws = null;
    }
    log.info(`接続先を切り替えます: ${host}`);
    this.connect();
    return true;
  }

  private buildUrl(): string {
    const params = new URLSearchParams();
    params.set('wantedCollections', WANTED_COLLECTION);
    const cursor = this.resolveCursor();
    if (cursor !== null) params.set('cursor', String(cursor));
    return `wss://${this.currentHost}/subscribe?${params.toString()}`;
  }

  /**
   * 再接続時のカーソル (マイクロ秒) を決める。
   * 最後に受信した time_us から replayWindowSec 秒だけ巻き戻して取りこぼしを補填する。
   * 初回接続では常に現在から購読し、過去の取り込みは BackfillReader が別接続で担当する。
   */
  private resolveCursor(): number | null {
    if (this.replayWindowSec > 0 && this.lastTimeUs !== null) {
      const rewindUs = this.replayWindowSec * 1_000_000;
      return Math.max(0, this.lastTimeUs - rewindUs);
    }
    return null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.buildUrl();
    log.info(`Jetstream へ接続します: ${url}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.handleFailure(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.ws = socket;

    socket.on('open', () => {
      this.consecutiveFailures = 0;
      this.reconnectAttempt = 0;
      this.armWatchdog();
      log.info(`Jetstream 接続成功: ${this.currentHost}`);
      this.emit('open', this.currentHost);
    });

    socket.on('message', (data: WebSocket.RawData) => {
      this.armWatchdog();
      this.handleMessage(data);
    });

    socket.on('pong', () => {
      this.armWatchdog();
    });

    socket.on('error', (err: Error) => {
      log.warn('Jetstream WebSocket エラー', err);
      this.emit('error', err);
    });

    socket.on('close', (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString('utf8');
      this.clearWatchdog();
      const host = this.currentHost;
      this.ws = null;
      this.emit('close', { host, code, reason });
      if (!this.stopped) {
        this.handleFailure(new Error(`closed: code=${code} reason=${reason}`));
      }
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch (err) {
      log.warn('Jetstream メッセージの JSON 解析に失敗', err);
      return;
    }
    const event = parsed as JetstreamEvent;
    if (typeof event.time_us === 'number') {
      this.lastTimeUs = event.time_us;
    }
    if (event.kind !== 'commit') return;
    this.emit('commit', event);
  }

  private handleFailure(err: Error): void {
    this.consecutiveFailures += 1;
    this.emit('error', err);

    if (this.consecutiveFailures >= this.hostFailoverAfter && this.hosts.length > 1) {
      this.hostIndex = (this.hostIndex + 1) % this.hosts.length;
      this.consecutiveFailures = 0;
      log.warn(`連続失敗によりホストを切り替えます: ${this.currentHost}`);
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAttempt += 1;
    const backoff = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * 2 ** (this.reconnectAttempt - 1)
    );
    // ジッタ (0.5x - 1.5x) を加える。
    const jittered = Math.floor(backoff * (0.5 + Math.random()));
    const delay = Math.max(this.reconnectMinMs, Math.min(this.reconnectMaxMs, jittered));
    log.info(`${delay}ms 後に再接続します (試行 ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      log.warn('ウォッチドッグ: 一定時間イベントが来ないため強制再接続します');
      if (this.ws) {
        try {
          this.ws.ping();
        } catch {
          // ping 失敗は無視し、強制切断する。
        }
        this.ws.terminate();
      }
    }, WATCHDOG_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
