/**
 * モジュール間で共有する型定義。
 * ingest / server / フロントエンドはすべてこの契約だけに依存する。
 */

/** 監視語の種別。 */
export type WatchTermType = 'hashtag' | 'keyword';

/**
 * 承認要否の指定。
 * 'inherit' は上位 (語 → ウォール → テナント) の設定に従う。
 * 'always' はその語に一致した投稿を必ず承認待ちにし、
 * 'never' は「キーワードのみ一致は承認待ち」の既定を免除する。
 */
export type ApprovalSetting = 'inherit' | 'always' | 'never';

/**
 * 除外キーワードに一致した投稿の扱い。
 * 'reject'  : 受信した時点で破棄する。承認待ちにも直近の投稿にも残さない (既定)。
 * 'approve' : 承認待ちに回し、運営が判断する。承認モードや語ごとの設定より優先する。
 */
export type ExcludePolicy = 'reject' | 'approve';

/**
 * 除外キーワード。本文に含まれていたらそのウォールでは拾わない。
 * ネガティブワードを会場スクリーンに出さないために使う。
 */
export interface ExcludeTerm {
  /** 入力された表記 */
  value: string;
  /** 比較用に正規化した値 (NFKC + 小文字化) */
  normalized: string;
}

/**
 * 会場モニターの画面モード。
 * 'wall' は通常 (投稿を流す)。それ以外は進行に合わせた案内画面を出す。
 */
export type ScreenMode = 'wall' | 'waiting' | 'break' | 'ended';

/** 任意画像 (QR コードなど) の位置。 */
export type ScreenImagePosition = 'bottom-right' | 'bottom-center' | 'bottom-left' | 'center';

/** 任意画像の大きさ。画面高に対する比率で決める。 */
export type ScreenImageSize = 'small' | 'medium' | 'large';

/** 会場モニターの画面モードと、その文言・画像の設定 (ウォール単位)。 */
export interface WallScreen {
  mode: ScreenMode;
  /** 待機画面の見出し。ハッシュタグ運用なら案内文にすると迷わせない */
  waitingHeadline: string;
  waitingHint: string;
  breakHeadline: string;
  /** 休憩の再開予定。空なら出さない */
  breakNote: string;
  endedHeadline: string;
  endedNote: string;
  /** 待機モードのとき、投稿が届いたら通常へ戻すか */
  autoResume: boolean;
  /** 任意画像を出すか (通常モードでは出さない) */
  showImage: boolean;
  imagePosition: ScreenImagePosition;
  imageSize: ScreenImageSize;
  /** 画像に添える一言 */
  imageCaption: string;
}

/** ウォール単位の承認モード。'inherit' はテナント設定に従う。 */
export type WallModerationMode = 'inherit' | ModerationMode;

/**
 * 監視対象の語。
 * hashtag は投稿者が明示的に付けたタグ、keyword は本文中の任意の文字列に一致する。
 */
export interface WatchTerm {
  /** 入力された表記 */
  value: string;
  type: WatchTermType;
  /** 比較用に正規化した値 (NFKC + 小文字化) */
  normalized: string;
  /**
   * この語に一致した投稿の承認要否。省略時は 'inherit'。
   * 意図して設定したキーワードを即時表示したい場合に 'never' を使う。
   * ウォールの承認モードが 'approve' のときは、この指定より承認モードが優先される。
   */
  requireApproval: ApprovalSetting;
}

/** 投稿者情報。プロフィール未解決の間は displayName / avatar が undefined になる。 */
export interface WallAuthor {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

/** 投稿に添付された画像。 */
export interface WallImage {
  thumb: string;
  fullsize: string;
  alt: string;
  aspectRatio?: { width: number; height: number };
}

/** 表示ステータス。approve モードでは pending を経由して visible になる。 */
export type WallPostStatus = 'visible' | 'pending' | 'hidden';

/** ウォールに流す 1 投稿。SSE の `post` イベントで送出される単位。 */
export interface WallPost {
  /** at://<did>/app.bsky.feed.post/<rkey> */
  uri: string;
  cid: string;
  rkey: string;
  did: string;
  author: WallAuthor;
  text: string;
  /** 一致した監視タグ (正規化前の表記) */
  matchedTags: string[];
  /** 一致した監視キーワード (設定された表記) */
  matchedKeywords: string[];
  /**
   * 一致した除外キーワード (設定された表記)。
   * 空でない投稿は会場モニターへ出さない。却下しても「非表示にした投稿」に残さず、
   * モデレーターが同じ文面を見続けずに済むようにする。
   */
  matchedExcludes?: string[];
  images: WallImage[];
  langs: string[];
  isReply: boolean;
  /** 投稿レコードの createdAt (ISO8601) */
  createdAt: string;
  /** サーバーが受信した時刻 (epoch ms) */
  receivedAt: number;
  /** Jetstream の time_us (マイクロ秒カーソル) */
  timeUs: number;
  /** https://bsky.app/profile/<did>/post/<rkey> */
  webUrl: string;
  status: WallPostStatus;
}

/** Jetstream 接続の状態。 */
export interface JetstreamStatus {
  connected: boolean;
  host: string | null;
  lastEventAt: number | null;
  reconnects: number;
  cursor: number | null;
  /** 起動時バックフィルを実行中か。ライブ受信とは独立に進む。 */
  backfilling: boolean;
}

/** 累計統計。 */
export interface WallStats {
  /** タグに一致した総数 (モデレーションで落ちたものを含む) */
  matched: number;
  /** 実際に表示へ流した総数 */
  displayed: number;
  /** モデレーションで除外した総数 */
  rejected: number;
  /** ユニーク投稿者数 */
  authors: number;
  /** サーバー起動時刻 (epoch ms) */
  startedAt: number;
}

/** ウォールの識別情報。複数モニターで別々の語を拾うために使う。 */
export interface WallSummary {
  id: string;
  name: string;
  terms: WatchTerm[];
  display: DisplayConfig;
  /** このウォールが表示中の件数 */
  postCount: number;
  /** このウォールの承認待ち件数 */
  pendingCount: number;
  /** .env から作られた既定ウォール。削除できない */
  isDefault: boolean;
  /** このウォールの承認モード設定 ('inherit' はテナント設定に従う) */
  moderationMode: WallModerationMode;
  /** キーワードのみ一致の扱い ('inherit' はテナント設定に従う) */
  keywordRequireApproval: ApprovalSetting;
  /**
   * 除外キーワード。管理 API にだけ載せる。
   * ネガティブワードそのものを会場モニターへ配らないため、WallState には含めない。
   */
  excludeTerms: ExcludeTerm[];
  /** 除外キーワードに一致した投稿の扱い */
  excludePolicy: ExcludePolicy;
  /** 画面モードの設定 */
  screen: WallScreen;
  /** 任意画像の配信 URL。未設定なら null */
  screenImageUrl: string | null;
}

/** ウォール全体の状態。SSE の `state` イベントで送出される。 */
export interface WallState {
  /** このウォールの ID */
  wallId: string;
  /** このウォールの名前 */
  wallName: string;
  /** 監視中のハッシュタグ (会場モニターのヘッダ表示に使う) */
  hashtags: string[];
  /** 監視中の語すべて (種別付き) */
  terms: WatchTerm[];
  eventTitle: string;
  eventSubtitle: string;
  /** タイトルの「Bluesky」をロゴアイコンで表示するか (テナント設定) */
  showBlueskyLogo: boolean;
  paused: boolean;
  /** このウォールに実際に適用されている承認モード (継承を解決済み) */
  moderationMode: ModerationMode;
  /** 承認モードの出どころ。継承中かどうかの表示に使う */
  moderationSource: 'tenant' | 'wall';
  /** このウォールの承認モード設定そのもの */
  wallModerationMode: WallModerationMode;
  /** キーワードのみ一致を承認待ちにするか (継承を解決済み) */
  keywordRequireApproval: boolean;
  /** キーワードのみ一致の扱いの設定そのもの */
  wallKeywordRequireApproval: ApprovalSetting;
  /** テナント既定 (継承元の表示に使う) */
  tenantModerationMode: ModerationMode;
  tenantKeywordRequireApproval: boolean;
  /** 画面モードと文言 (会場モニターが描画に使う) */
  screen: WallScreen;
  /** 任意画像の配信 URL。未設定なら null */
  screenImageUrl: string | null;
  jetstream: JetstreamStatus;
  stats: WallStats;
}

export type ModerationMode = 'open' | 'approve';

/** SSE `hello` イベントのペイロード。 */
export interface HelloPayload {
  state: WallState;
  backlog: WallPost[];
  display: DisplayConfig;
}

/** フロントエンドの表示設定。サーバーから配布する。 */
export interface DisplayConfig {
  maxCards: number;
  columns: number;
  cardTtlSec: number;
  showImages: boolean;
  /** 会場モニターのヘッダに監視語を出すか (待機画面のハッシュタグ表示とは別) */
  showTerms: boolean;
  /**
   * ヘッダに監視キーワードも出すか。既定は false。
   * キーワードは投稿者に入力を促すものではなく、会場に見せる必要がないため。
   */
  showKeywords: boolean;
  /** 会場モニター右上の時計を出すか */
  showClock: boolean;
  /** 時計に秒を出すか (時分の右下に小さく添える)。時計自体が非表示なら無視される */
  showSeconds: boolean;
}

/** SSE `profile` イベントのペイロード。 */
export interface ProfileUpdatePayload {
  did: string;
  author: WallAuthor;
}

/** SSE `remove` イベントのペイロード。 */
export interface RemovePayload {
  uri: string;
  reason: 'deleted' | 'hidden' | 'cleared';
}

/** バックフィル (過去の取り込み) の実行状況。 */
export interface BackfillStatus {
  running: boolean;
  /** 今回 / 直近の実行で遡った分数 */
  minutes: number;
  /** 対象ウォール。null なら全ウォール */
  targetWallId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 現在に追いつけたか。打ち切られた場合は false */
  caughtUp: boolean;
  /** 直近の実行で表示に加わった件数 (ウォール合計) */
  added: number;
}

/** 購読中のモデレーションリストの状態。 */
export interface ModListInfo {
  uri: string;
  name: string;
  purpose: string;
  /** 実際に読み込めたメンバー数 */
  memberCount: number;
  lastFetchedAt: number | null;
  /** 直近の取得に失敗した場合の理由 */
  error?: string;
}

/** Jetstream から受け取る生イベント (必要な部分のみ)。 */
export interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: 'commit' | 'identity' | 'account';
  commit?: JetstreamCommit;
}

export interface JetstreamCommit {
  rev: string;
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  cid?: string;
  record?: BskyPostRecord;
}

/** app.bsky.feed.post のレコード (利用するフィールドのみ)。 */
export interface BskyPostRecord {
  $type?: string;
  text?: string;
  createdAt?: string;
  langs?: string[];
  tags?: string[];
  facets?: BskyFacet[];
  reply?: unknown;
  embed?: BskyEmbed;
  labels?: { $type?: string; values?: { val: string }[] };
}

export interface BskyFacet {
  index?: { byteStart: number; byteEnd: number };
  features?: { $type?: string; tag?: string; uri?: string; did?: string }[];
}

export interface BskyEmbed {
  $type?: string;
  images?: { image?: BlobRef; alt?: string; aspectRatio?: { width: number; height: number } }[];
  media?: BskyEmbed;
  record?: unknown;
}

export interface BlobRef {
  $type?: string;
  ref?: { $link?: string } | string;
  mimeType?: string;
  size?: number;
}
