import type {
  ProfileUpdatePayload,
  RemovePayload,
  WallPost,
  WallState,
} from './types.js';

/**
 * ingest 層が server 層へ公開する唯一のインターフェース。
 * server は Jetstream の存在を知らず、このイベントだけを購読する。
 */
export interface WallSourceEvents {
  /** 表示対象として確定した投稿 */
  post: (post: WallPost) => void;
  /** 承認待ちに入った投稿 (approve モード時のみ) */
  pending: (post: WallPost) => void;
  /**
   * 起動時バックフィルで取得した過去の投稿 (新しい順)。
   * ライブ投稿より下に追加される。取り込み完了後に一度だけ発火する。
   */
  history: (posts: WallPost[]) => void;
  /** 後追いで解決した投稿者プロフィール */
  profile: (payload: ProfileUpdatePayload) => void;
  /** 削除・非表示になった投稿 */
  remove: (payload: RemovePayload) => void;
  /** 状態変化 (接続状態・一時停止・統計) */
  state: (state: WallState) => void;
}

/** ingest 層の実体が満たすべき契約。 */
export interface WallSource {
  on<K extends keyof WallSourceEvents>(event: K, listener: WallSourceEvents[K]): void;
  off<K extends keyof WallSourceEvents>(event: K, listener: WallSourceEvents[K]): void;

  /** Jetstream への接続を開始する。 */
  start(): Promise<void>;
  /** 接続を閉じ、保留中のタイマーを解放する。 */
  stop(): Promise<void>;

  /** 現在の状態スナップショット。 */
  getState(): WallState;
  /** 表示中の直近投稿を新しい順で返す。 */
  getRecent(limit: number): WallPost[];
  /** 承認待ちの投稿を新しい順で返す (approve モード時)。 */
  getPending(limit: number): WallPost[];

  /** 一時停止の切り替え。停止中は post イベントを発火しない。 */
  setPaused(paused: boolean): WallState;
  /** 個別投稿を非表示にする。 */
  hide(uri: string): boolean;
  /** 承認待ちの投稿を表示へ昇格させる。 */
  approve(uri: string): boolean;
  /** 投稿者をブロックし、その投稿を表示から取り下げる。 */
  blockActor(actor: string): number;
  /** 表示中の投稿をすべて消去する。 */
  clear(): void;
}
