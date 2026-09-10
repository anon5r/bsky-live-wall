/**
 * 受信基盤とテナントの境界。
 *
 * Jetstream への接続はサーバー全体で 1 本だけ張り、受信した投稿を
 * 各テナント・各ウォールの監視語と突き合わせて振り分ける。
 * テナントごとに接続を張ると同じ全量を何度も受信することになり、
 * 帯域と相手側の負荷が無駄に増える。
 *
 *   IngestHub (1 個)              JetstreamClient / BackfillReader / ProfileHydrator
 *        |
 *        +--> TenantRuntime A     walls, モデレーション, 設定
 *        +--> TenantRuntime B
 *
 * TenantRuntime は WallSource を実装する。server 層から見た形は
 * 単一テナント運用のときと変わらない。
 */
import type { JetstreamEvent, JetstreamStatus, BackfillStatus } from './types.js';
import type { WallSource } from './contracts.js';
import type { Tenant, TenantMember, TenantSettings } from './tenancy.js';
import type { WallAuthor } from './types.js';

/** 受信の出どころ。バックフィルは要求元のテナントにしか配らない。 */
export interface IngestCommit {
  event: JetstreamEvent;
  source: 'live' | 'backfill';
  /** source が 'backfill' のとき、その取り込みを要求したテナント ID */
  backfillOwner?: string;
}

export interface IngestHubEvents {
  commit: (commit: IngestCommit) => void;
  /** 後追いで解決した投稿者プロフィール (全テナント共通のキャッシュ) */
  profile: (payload: { did: string; author: WallAuthor }) => void;
  /** 接続状態の変化 */
  status: (status: JetstreamStatus) => void;
  /** バックフィルの完了 */
  backfillDone: (status: BackfillStatus) => void;
}

/**
 * Jetstream 接続とプロフィール解決を全テナントで共有する層。
 * テナントの存在を知らず、受信したものを配るだけに徹する。
 */
export interface IngestHub {
  on<K extends keyof IngestHubEvents>(event: K, listener: IngestHubEvents[K]): void;
  off<K extends keyof IngestHubEvents>(event: K, listener: IngestHubEvents[K]): void;

  start(): Promise<void>;
  stop(): Promise<void>;

  getStatus(): JetstreamStatus;
  getHosts(): string[];
  switchHost(host: string): boolean;

  /**
   * 過去の取り込みを開始する。接続は 1 本しかないため同時に 1 件だけ。
   * 実行中の要求は拒否する。
   */
  startBackfill(input: { minutes: number; owner: string }): { ok: boolean; message?: string };
  getBackfillStatus(): BackfillStatus;

  /** 投稿者のプロフィールを引く (未解決なら後から profile イベントで届く)。 */
  resolveAuthor(did: string): WallAuthor;
}

/** テナント 1 つ分の実行時。server 層へは WallSource として見える。 */
export interface TenantRuntime extends WallSource {
  readonly tenantId: string;
  /** 表示名など。管理画面の一覧に使う。 */
  getTenant(): Tenant;
  /** 設定を更新する (multi では永続化も行う)。 */
  updateSettings(patch: Partial<TenantSettings>): void;
  /** このテナントを操作できるアカウント。 */
  listMembers(): TenantMember[];
  /** 権限判定。メンバーでなければ undefined。 */
  getMemberRole(did: string): TenantMember['role'] | undefined;
}

/**
 * テナントの集合。
 * single モードでは `.env` から作った 1 件だけを持ち、DB を使わない。
 * multi モードでは TenantStore を出どころとする。
 */
export interface TenantRegistry {
  start(): Promise<void>;
  stop(): Promise<void>;

  /** 既定テナント。single モードではこれが唯一のテナント。 */
  getDefault(): TenantRuntime;
  get(tenantId: string): TenantRuntime | undefined;
  list(): TenantRuntime[];

  /** この DID が操作できるテナント。ログイン後の一覧に使う。 */
  listForDid(did: string): TenantRuntime[];

  /** multi モードのみ。single では例外を投げる。 */
  create(input: {
    id: string;
    name: string;
    ownerDid: string;
    ownerHandle: string;
    settings?: Partial<TenantSettings>;
  }): TenantRuntime;
  remove(tenantId: string): boolean;

  /** 受信基盤。ホスト切り替えなど全体に効く操作はここから行う。 */
  readonly hub: IngestHub;
}
