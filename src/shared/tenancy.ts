/**
 * マルチテナント運用のためのデータ契約。
 *
 * 単一テナント (会場ローカル) では `.env` が設定の出どころで、状態はメモリ上に
 * 置いたままで足りる。共有サービスとして動かす場合はテナントが再起動を跨いで
 * 残る必要があるため、ここで定義した形で永続化する。
 */
import type {
  ApprovalSetting,
  DisplayConfig,
  ExcludePolicy,
  ExcludeTerm,
  ModerationMode,
  WallModerationMode,
  WallScreen,
  WatchTerm,
} from './types.js';

/** 運用モード。`.env` の `MULTI_TENANT` で切り替える。 */
export type TenancyMode = 'single' | 'multi';

/** テナント (= イベント主催者の単位)。 */
export interface Tenant {
  /** URL に載るスラッグ。`/e/<id>/...` */
  id: string;
  name: string;
  /** 作成者の DID。最後の 1 人として必ず管理権限を持つ。 */
  ownerDid: string;
  createdAt: number;
  updatedAt: number;
  settings: TenantSettings;
}

/**
 * テナントごとの設定。
 * 単一テナント運用では `.env` が同じ役割を果たす。
 */
export interface TenantSettings {
  title: string;
  subtitle: string;
  moderationMode: ModerationMode;
  keywordRequireApproval: boolean;
  /** 公開したくない値。テナントの外へ出さないこと。 */
  ngWords: string[];
  ngPatterns: string[];
  blockActors: string[];
  allowReplies: boolean;
  filterLabeled: boolean;
  allowedLangs: string[];
  startupBackfillMinutes: number;
  /**
   * 取り込みで遡れる時間の候補 (分)。管理画面のメニューに出る。
   * システム既定 (`.env` の BACKFILL_PRESETS) を初期値に、テナントが足せる。
   */
  backfillPresets: number[];
  /**
   * 会場モニターのタイトルに含まれる「Bluesky」をロゴアイコンで表示するか。
   * イベントによってはロゴを出したくない (主催者ロゴと並べたくない等) ため切り替えられる。
   */
  showBlueskyLogo: boolean;
  /**
   * 会場モニターのタイトルのグラデーションをゆっくり動かすか。
   * 既定は止めておく (動くものが常に視界にあると疲れるため)。
   */
  animateTitleGradient: boolean;
}

/** テナントを操作できるアカウント。招待制の実体。 */
export interface TenantMember {
  tenantId: string;
  did: string;
  handle: string;
  /** owner は設定変更まで、moderator は運用操作のみ。 */
  role: 'owner' | 'moderator';
  addedAt: number;
}

/** 永続化されたウォール定義。 */
export interface PersistedWall {
  tenantId: string;
  /** テナント内で一意なスラッグ。 */
  id: string;
  name: string;
  terms: WatchTerm[];
  display: DisplayConfig;
  isDefault: boolean;
  /** 管理画面での並び順。 */
  position: number;
  /** このウォールの承認モード。'inherit' はテナント設定に従う。 */
  moderationMode: WallModerationMode;
  /** キーワードのみ一致の扱い。'inherit' はテナント設定に従う。 */
  keywordRequireApproval: ApprovalSetting;
  /** 除外キーワード。本文に含まれていたらこのウォールでは拾わない。 */
  excludeTerms: ExcludeTerm[];
  /** 除外キーワードに一致した投稿の扱い。 */
  excludePolicy: ExcludePolicy;
  /** 画面モードと文言。 */
  screen: WallScreen;
  /** 任意画像。data ディレクトリ配下のファイル名で持つ。 */
  screenImage: PersistedScreenImage | null;
}

/** 会場モニターに出す任意画像 (QR コードなど)。実体はファイル、DB にはメタだけ置く。 */
export interface PersistedScreenImage {
  /** アップロード先ディレクトリからの相対ファイル名 */
  file: string;
  mime: string;
  /** キャッシュを外すための更新時刻 (epoch ms) */
  updatedAt: number;
}

/** 購読中のモデレーションリスト。 */
export interface PersistedModList {
  tenantId: string;
  uri: string;
  addedAt: number;
}

export interface CreateTenantInput {
  id: string;
  name: string;
  ownerDid: string;
  ownerHandle: string;
  settings?: Partial<TenantSettings>;
}

/**
 * 永続化層の契約。
 *
 * 実装は同期 API とする。SQLite の同期ドライバを使い、扱う件数も小さいため、
 * 非同期にしても複雑さが増えるだけで得るものがない。
 */
export interface TenantStore {
  // ---- テナント ----
  listTenants(): Tenant[];
  getTenant(id: string): Tenant | undefined;
  createTenant(input: CreateTenantInput): Tenant;
  updateTenant(id: string, patch: { name?: string; settings?: Partial<TenantSettings> }): Tenant | undefined;
  deleteTenant(id: string): boolean;

  // ---- メンバー ----
  listMembers(tenantId: string): TenantMember[];
  addMember(member: Omit<TenantMember, 'addedAt'>): TenantMember;
  removeMember(tenantId: string, did: string): boolean;
  /** この DID が操作できるテナント。ログイン後の一覧表示に使う。 */
  findTenantsForDid(did: string): Tenant[];
  /** 権限判定。メンバーでなければ undefined。 */
  getMemberRole(tenantId: string, did: string): TenantMember['role'] | undefined;

  // ---- ウォール ----
  listWalls(tenantId: string): PersistedWall[];
  upsertWall(wall: PersistedWall): PersistedWall;
  deleteWall(tenantId: string, wallId: string): boolean;

  // ---- モデレーションリスト ----
  listModLists(tenantId: string): PersistedModList[];
  addModList(tenantId: string, uri: string): PersistedModList;
  removeModList(tenantId: string, uri: string): boolean;

  close(): void;
}
