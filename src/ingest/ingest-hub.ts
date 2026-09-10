/**
 * サーバー全体で 1 個だけ存在する受信基盤。
 *
 * Jetstream への接続 (ライブ 1 本 + バックフィル 1 本) とプロフィール解決を
 * 全テナントで共有する。テナントや Wall の存在は一切知らず、受信した
 * commit をそのまま配るだけに徹する (振り分け・モデレーション・バッファリング
 * は呼び出し側 = WallManager / 将来の TenantRuntime の責務)。
 *
 * バックフィルは接続が 1 本しかないため同時に 1 件だけ実行できる。
 * 要求元は `owner` (テナント ID) として記録し、再生中の commit に
 * `backfillOwner` を付けて返す。これにより将来複数テナントが同時に
 * 存在しても、要求元以外のテナントへ過去分が漏れ配信されることはない。
 */
import { EventEmitter } from 'node:events';
import type { AppConfig } from '../shared/config.js';
import type { BackfillStatus, JetstreamStatus, WallAuthor } from '../shared/types.js';
import type { IngestCommit, IngestHub, IngestHubEvents } from '../shared/ingest-contracts.js';
import { createLogger } from '../shared/logger.js';
import { JetstreamClient } from './jetstream-client.js';
import { BackfillReader } from './backfill-reader.js';
import { ProfileHydrator } from './profile-hydrator.js';

const log = createLogger('ingest-hub');

/** 遡れる上限。Jetstream の保持期間 (実測およそ 36 時間) に合わせる。 */
const MAX_BACKFILL_MINUTES = 2160;

export class JetstreamIngestHub extends EventEmitter implements IngestHub {
  private readonly jetstream: JetstreamClient;
  private readonly backfill: BackfillReader;
  private readonly hydrator: ProfileHydrator;

  private status: JetstreamStatus = {
    connected: false,
    host: null,
    lastEventAt: null,
    reconnects: 0,
    cursor: null,
    backfilling: false,
  };

  private backfillStatus: BackfillStatus = {
    running: false,
    minutes: 0,
    targetWallId: null,
    startedAt: null,
    finishedAt: null,
    caughtUp: false,
    added: 0,
  };
  /** 実行中のバックフィルを要求したテナント ID。 */
  private backfillOwner: string | null = null;

  declare on: <K extends keyof IngestHubEvents>(event: K, listener: IngestHubEvents[K]) => this;
  declare off: <K extends keyof IngestHubEvents>(event: K, listener: IngestHubEvents[K]) => this;
  declare emit: <K extends keyof IngestHubEvents>(
    event: K,
    ...args: Parameters<IngestHubEvents[K]>
  ) => boolean;

  constructor(config: AppConfig) {
    super();
    this.jetstream = new JetstreamClient(config.jetstream);
    this.backfill = new BackfillReader(config.jetstream);
    this.hydrator = new ProfileHydrator(config);

    this.jetstream.on('open', (host) => {
      this.status = { ...this.status, connected: true, host };
      this.emit('status', this.getStatus());
    });
    this.jetstream.on('close', () => {
      this.status = {
        ...this.status,
        connected: false,
        reconnects: this.status.reconnects + 1,
      };
      this.emit('status', this.getStatus());
    });
    this.jetstream.on('error', (err) => log.warn('Jetstream エラー', err));
    this.jetstream.on('commit', (event) => {
      // 接続状態の一部として最終受信時刻を持つ。再描画のたびに変えると
      // SSE が溢れるので、ここでは状態だけ更新し通知はしない
      // (呼び出し側が state を組み立てる際に getStatus() で拾う)。
      this.status = { ...this.status, lastEventAt: Date.now() };
      this.emit('commit', { event, source: 'live' });
    });

    this.backfill.on('commit', (event) => {
      this.status = { ...this.status, lastEventAt: Date.now() };
      const commit: IngestCommit =
        this.backfillOwner !== null
          ? { event, source: 'backfill', backfillOwner: this.backfillOwner }
          : { event, source: 'backfill' };
      this.emit('commit', commit);
    });
    this.backfill.on('done', (info) => {
      this.backfillOwner = null;
      this.backfillStatus = {
        ...this.backfillStatus,
        running: false,
        finishedAt: Date.now(),
        caughtUp: info.caughtUp,
      };
      this.status = { ...this.status, backfilling: false };
      this.emit('status', this.getStatus());
      this.emit('backfillDone', { ...this.backfillStatus });
    });

    this.hydrator.on('profile', (payload) => this.emit('profile', payload));
  }

  async start(): Promise<void> {
    this.jetstream.start();
  }

  async stop(): Promise<void> {
    this.backfill.stop();
    this.jetstream.stop();
    this.hydrator.stop();
  }

  getStatus(): JetstreamStatus {
    // cursor は commit のたびに動くので、都度 JetstreamClient から取り直す。
    return { ...this.status, cursor: this.jetstream.cursor };
  }

  getHosts(): string[] {
    return this.jetstream.availableHosts;
  }

  switchHost(host: string): boolean {
    const ok = this.jetstream.switchHost(host);
    if (ok) {
      this.status = { ...this.status, connected: false, host };
      this.emit('status', this.getStatus());
    }
    return ok;
  }

  startBackfill(input: { minutes: number; owner: string }): { ok: boolean; message?: string } {
    if (this.backfillStatus.running) {
      return { ok: false, message: 'バックフィルが既に実行中です' };
    }
    const minutes = Math.floor(input.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, message: '遡る分数は 1 以上で指定してください' };
    }
    if (minutes > MAX_BACKFILL_MINUTES) {
      return {
        ok: false,
        message: `Jetstream の保持期間の都合で ${MAX_BACKFILL_MINUTES} 分 (約 36 時間) までです`,
      };
    }

    this.backfillOwner = input.owner;
    this.backfillStatus = {
      running: true,
      minutes,
      // ウォール単位の絞り込みはテナント側の関心事なのでハブは知らない。
      targetWallId: null,
      startedAt: Date.now(),
      finishedAt: null,
      caughtUp: false,
      added: 0,
    };
    this.status = { ...this.status, backfilling: true };
    this.emit('status', this.getStatus());
    this.backfill.run(minutes);
    return { ok: true };
  }

  getBackfillStatus(): BackfillStatus {
    return { ...this.backfillStatus };
  }

  resolveAuthor(did: string): WallAuthor {
    return this.hydrator.resolve(did, did);
  }
}

export function createIngestHub(config: AppConfig): IngestHub {
  return new JetstreamIngestHub(config);
}
