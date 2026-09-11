import type {
  ApprovalSetting,
  BackfillStatus,
  ExcludePolicy,
  ExcludeTerm,
  DisplayConfig,
  ModListInfo,
  ProfileUpdatePayload,
  RemovePayload,
  WallModerationMode,
  WallPost,
  WallScreen,
  WallState,
  WallSummary,
  WatchTerm,
  WatchTermType,
} from './types.js';
import type { PersistedScreenImage } from './tenancy.js';

/**
 * ingest 層が server 層へ公開する唯一のインターフェース。
 * server は Jetstream の存在を知らず、このイベントだけを購読する。
 *
 * 複数のウォールを扱うため、イベントにはウォール ID が付く。
 * モデレーション (ブロック / 非表示 / NG ワード / リスト購読 / 一時停止) は
 * 全ウォール共通で、監視語・投稿バッファ・承認待ちはウォールごとに独立する。
 */
export interface WallSourceEvents {
  /** 表示対象として確定した投稿 */
  post: (wallId: string, post: WallPost) => void;
  /** 承認待ちに入った投稿 */
  pending: (wallId: string, post: WallPost) => void;
  /** バックフィルで確定した過去の投稿 (新しい順) */
  history: (wallId: string, posts: WallPost[]) => void;
  /** 後追いで解決した投稿者プロフィール (全ウォール共通) */
  profile: (payload: ProfileUpdatePayload) => void;
  /** 削除・非表示になった投稿 */
  remove: (wallId: string, payload: RemovePayload) => void;
  /** 状態変化 (接続状態・一時停止・統計) */
  state: (wallId: string, state: WallState) => void;
  /** ウォールの追加・削除・改名 */
  walls: (walls: WallSummary[]) => void;
}

/** ウォール 1 つ分の操作。 */
export interface WallHandle {
  readonly id: string;
  getState(): WallState;
  getRecent(limit: number): WallPost[];
  getPending(limit: number): WallPost[];
  /** 監視語 (ハッシュタグ / キーワード) を差し替える。 */
  setTerms(
    terms: { value: string; type: WatchTermType; requireApproval?: ApprovalSetting }[]
  ): WatchTerm[];
  getTerms(): WatchTerm[];
  /** 画面モードと文言。 */
  getScreen(): { screen: WallScreen; imageUrl: string | null };
  /** 画面モード / 文言を部分更新する。 */
  setScreen(patch: Partial<WallScreen>): { screen: WallScreen; imageUrl: string | null };
  /** 任意画像を差し替える (null で削除)。 */
  setScreenImage(image: PersistedScreenImage | null): { screen: WallScreen; imageUrl: string | null };
  /** 除外キーワードと、その扱い。 */
  getExcludes(): { terms: ExcludeTerm[]; policy: ExcludePolicy };
  /** 除外キーワード / 扱いを差し替える。省略した項目は変えない。 */
  setExcludes(input: { terms?: { value: string }[]; policy?: ExcludePolicy }): {
    terms: ExcludeTerm[];
    policy: ExcludePolicy;
  };
  /** 承認待ちの投稿を表示へ昇格させる。 */
  approve(uri: string): boolean;
  /** このウォールの表示をすべて消去する。 */
  clear(): void;
}

/** ingest 層の実体が満たすべき契約。 */
export interface WallSource {
  on<K extends keyof WallSourceEvents>(event: K, listener: WallSourceEvents[K]): void;
  off<K extends keyof WallSourceEvents>(event: K, listener: WallSourceEvents[K]): void;

  /** Jetstream への接続を開始する。 */
  start(): Promise<void>;
  /** 接続を閉じ、保留中のタイマーを解放する。 */
  stop(): Promise<void>;

  // ---- ウォール ----
  /** すべてのウォールの概要。 */
  getWalls(): WallSummary[];
  /** ID を指定してウォールを取り出す。存在しなければ undefined。 */
  getWall(id: string): WallHandle | undefined;
  /** 既定ウォール。`/wall` で開かれる。 */
  getDefaultWall(): WallHandle;
  /** ウォールを追加する。 */
  createWall(input: {
    id?: string;
    name: string;
    terms: { value: string; type: WatchTermType; requireApproval?: ApprovalSetting }[];
    display?: Partial<DisplayConfig>;
    moderationMode?: WallModerationMode;
    keywordRequireApproval?: ApprovalSetting;
  }): WallSummary;
  /** ウォールを削除する。既定ウォールは削除できない。 */
  deleteWall(id: string): boolean;
  /** ウォールの名前や表示設定を更新する。 */
  updateWall(
    id: string,
    input: {
      name?: string;
      display?: Partial<DisplayConfig>;
      moderationMode?: WallModerationMode;
      keywordRequireApproval?: ApprovalSetting;
    }
  ): WallSummary | undefined;

  // ---- 全ウォール共通のモデレーション ----
  /** 一時停止の切り替え。停止中は post イベントを発火しない。 */
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  /** 個別投稿を非表示にする (全ウォールから消える)。 */
  hide(uri: string): boolean;
  /** 非表示にした投稿を復元する。 */
  unhide(uri: string): boolean;
  /** 非表示にした投稿の一覧を新しい順で返す。 */
  getHidden(limit: number): WallPost[];
  /** 投稿者をブロックし、その投稿を全ウォールから取り下げる。 */
  blockActor(actor: string): number;
  /** 投稿者のブロックを解除し、取り下げた投稿を復元する。 */
  unblockActor(actor: string): number;
  /** ブロック中の投稿者一覧 (DID またはハンドル)。 */
  getBlockedActors(): string[];

  // ---- バックフィル (過去の取り込み) ----
  /**
   * 過去に遡って投稿を取り込む。
   * wallId を指定するとそのウォールだけに反映し、省略すると全ウォールに反映する。
   */
  startBackfill(input: { minutes: number; wallId?: string }): { ok: boolean; message?: string };
  getBackfillStatus(): BackfillStatus;

  // ---- Jetstream ----
  getJetstreamHosts(): string[];
  switchJetstreamHost(host: string): boolean;

  // ---- モデレーションリスト ----
  getModLists(): ModListInfo[];
  subscribeModList(uri: string): Promise<{ info: ModListInfo; removed: number }>;
  unsubscribeModList(uri: string): boolean;
}
