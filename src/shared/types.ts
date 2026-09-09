/**
 * モジュール間で共有する型定義。
 * ingest / server / フロントエンドはすべてこの契約だけに依存する。
 */

/** 監視語の種別。 */
export type WatchTermType = 'hashtag' | 'keyword';

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
  paused: boolean;
  moderationMode: ModerationMode;
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
