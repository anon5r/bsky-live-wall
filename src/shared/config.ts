import 'dotenv/config';
import type {
  ApprovalSetting,
  ExcludeTerm,
  ModerationMode,
  WallScreen,
  WatchTerm,
  WatchTermType,
} from './types.js';
import type { TenancyMode } from './tenancy.js';

/** 管理画面の認証方式。 */
export type AuthMode = 'token' | 'oauth' | 'both';

/** 環境変数から組み立てるアプリケーション設定。既定値はすべてここで一元管理する。 */
export interface AppConfig {
  tenancy: {
    /**
     * single: 会場ローカルなど 1 イベント専用。設定は .env、URL は短い形。
     * multi : 共有サービス。テナントを永続化し、URL に /e/<tenant>/ が入る。
     */
    mode: TenancyMode;
    /** テナント設定の保存先 (multi のときのみ使う)。 */
    dataFile: string;
    /** 会場モニターに出す任意画像 (QR など) の保存先ディレクトリ (ローカル保存のとき)。 */
    uploadDir: string;
  };
  /**
   * 会場モニターに出す画像の保存先。
   * 'local' はディスク、's3' は S3 互換ストレージ
   * (Cloudflare R2 / MEGA S4 / AWS S3 / Backblaze B2 など)。
   */
  storage: {
    driver: 'local' | 's3';
    s3: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      /** キーの接頭辞。バケットを他と共有する場合に使う */
      prefix: string;
      /**
       * 画像を直接配る URL の基点 (公開バケットやカスタムドメイン)。
       * 空ならアプリが `/uploads/<key>` で中継する。
       */
      publicBaseUrl: string;
      /** `https://<endpoint>/<bucket>/<key>` の形で叩くか (既定)。 */
      forcePathStyle: boolean;
    };
  };
  event: {
    /**
     * イベント (テナント) の識別子。URL に `/e/<id>/` として現れる。
     * 現状は 1 サーバー 1 イベントだが、将来のマルチテナント化で
     * URL を変えずに済むよう、この段階から経路に組み込んでおく。
     */
    id: string;
    title: string;
    subtitle: string;
    hashtags: string[];
    /** タイトルの「Bluesky」をロゴアイコンで表示するか */
    showBlueskyLogo: boolean;
    /** タイトルのグラデーションをゆっくり動かすか */
    animateTitleGradient: boolean;
    /** 比較用に正規化 (NFKC + 小文字 + 先頭 # 除去) 済みのタグ */
    normalizedHashtags: string[];
    /** 既定ウォールの除外キーワードの初期値 */
    excludeTerms: ExcludeTerm[];
    /** 監視語すべて (ハッシュタグ + キーワード) */
    terms: WatchTerm[];
  };
  server: {
    port: number;
    host: string;
    logLevel: string;
    /** リバースプロキシ配下で動かすか。true なら X-Forwarded-For を信頼する。 */
    trustProxy: boolean;
  };
  jetstream: {
    hosts: string[];
    reconnectMinMs: number;
    reconnectMaxMs: number;
    hostFailoverAfter: number;
    replayWindowSec: number;
    startupBackfillMinutes: number;
  };
  buffer: {
    size: number;
    backlogSize: number;
  };
  display: {
    maxCards: number;
    columns: number;
    cardTtlSec: number;
    showImages: boolean;
    showClock: boolean;
    showSeconds: boolean;
    showTerms: boolean;
    showKeywords: boolean;
  };
  moderation: {
    mode: ModerationMode;
    ngWords: string[];
    ngPatterns: RegExp[];
    /**
     * ngPatterns のコンパイル前の文字列。`TenantSettings.ngPatterns` は
     * (SQLite に保存するため) 文字列で持つので、single モードのテナントを
     * 組み立てる際にここから復元する。
     */
    ngPatternSources: string[];
    blockActors: string[];
    allowReplies: boolean;
    filterLabeled: boolean;
    allowedLangs: string[];
    /**
     * キーワードだけで一致した投稿を承認待ちに回すか。
     * ハッシュタグと違い、キーワード一致はイベントを知らない第三者の投稿を
     * 拾ってしまうため、既定では運営の確認を挟む。
     */
    keywordRequireApproval: boolean;
  };
  admin: {
    token: string;
    /** 管理セッションの有効時間 (時間)。イベントの最大長に合わせる。 */
    sessionTtlHours: number;
    /** 認証方式。oauth では AT Protocol アカウントでログインする。 */
    authMode: AuthMode;
    /**
     * 管理を許可するアカウント (ハンドルまたは DID)。招待制の実体。
     * OAuth で本人確認できても、ここに載っていなければ管理できない。
     */
    allowedActors: string[];
    /**
     * システム管理者 (ハンドルまたは DID)。全テナントに対して owner 相当の権限を持つ。
     * テナントのメンバー表 (DB) ではなく `.env` に置く。テナントが 1 件も無い
     * 初期状態でも管理者が存在する必要があり、DB が壊れても締め出されないため。
     */
    systemAdmins: string[];
  };
  oauth: {
    /** 公開 URL。client_id とリダイレクト先の組み立てに使う。 */
    publicUrl: string;
    /** 開発時に http を許可する。localhost 以外では使わない。 */
    allowHttp: boolean;
  };
  appview: {
    url: string;
    profileCacheTtlSec: number;
  };
  feedGenerator: {
    enabled: boolean;
    hostname: string;
    rkey: string;
    publisherDid: string;
  };
}

/**
 * URL に載せる識別子 (イベント ID / ウォール ID) を正規化する。
 * 経路の一部になるため、扱える文字種を厳しく絞る。
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * 経路として予約済みの識別子。
 * ウォール ID やイベント ID がこれらと衝突すると URL が曖昧になる。
 */
export const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'assets',
  'e',
  'wall',
  'walls',
  'xrpc',
  'vendor',
  'static',
  'health',
  'login',
  'logout',
  'auth',
  'client-metadata',
  'well-known',
]);

/** キーワード比較用の正規化。タグと違い先頭の # は落とさない。 */
export function normalizeKeyword(word: string): string {
  return word.normalize('NFKC').trim().toLowerCase();
}

/**
 * 入力された監視語を正規化し、重複を取り除く。
 * ハッシュタグとキーワードは同じ表記でも別物として扱う。
 */
export function buildTerms(
  input: { value: string; type: WatchTermType; requireApproval?: ApprovalSetting }[]
): WatchTerm[] {
  const seen = new Set<string>();
  const out: WatchTerm[] = [];
  for (const { value, type, requireApproval } of input) {
    const trimmed = type === 'hashtag' ? value.trim().replace(/^[#＃]+/, '') : value.trim();
    if (trimmed === '') continue;
    const normalized = type === 'hashtag' ? normalizeTag(trimmed) : normalizeKeyword(trimmed);
    if (normalized === '') continue;
    const key = `${type}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 過去に保存された監視語には requireApproval が無い。継承として扱う。
    out.push({ value: trimmed, type, normalized, requireApproval: requireApproval ?? 'inherit' });
  }
  return out;
}

/** システム既定の取り込み候補 (分)。テナントはこれを初期値に足し引きする。 */
export function defaultBackfillPresets(): number[] {
  const raw = list('BACKFILL_PRESETS', ['30', '120', '360', '1440']);
  const out: number[] = [];
  for (const item of raw) {
    const n = Number.parseInt(item, 10);
    if (Number.isFinite(n) && n > 0 && n <= 2160 && !out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 会場モニターの画面モードの既定値。文言は管理画面から変更できる。 */
export function defaultWallScreen(): WallScreen {
  return {
    mode: 'wall',
    waitingHeadline: 'ハッシュタグはこちら',
    waitingHint: 'このタグをつけて投稿すると、この画面に表示されます',
    breakHeadline: '休憩中',
    breakNote: '',
    endedHeadline: '本日はありがとうございました',
    endedNote: '',
    autoResume: true,
    showImage: false,
    imagePosition: 'bottom-right',
    imageSize: 'medium',
    imageCaption: '',
  };
}

/**
 * 除外キーワードを正規化して組み立てる。
 * 監視キーワードと同じ正規化 (NFKC + 小文字化) を使い、判定のぶれを無くす。
 */
export function buildExcludeTerms(input: { value: string }[] | string[]): ExcludeTerm[] {
  const seen = new Set<string>();
  const out: ExcludeTerm[] = [];
  for (const entry of input) {
    const raw = typeof entry === 'string' ? entry : entry.value;
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') continue;
    const normalized = normalizeKeyword(trimmed);
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ value: trimmed, normalized });
  }
  return out;
}

/** 文字列をタグ比較用に正規化する。ingest と server で同じ関数を使うこと。 */
export function normalizeTag(tag: string): string {
  return tag.normalize('NFKC').replace(/^#+/, '').trim().toLowerCase();
}

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function list(key: string, fallback: string[] = []): string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** NG 正規表現の文字列表現をコンパイルする。ingest 層 (TenantSettings 由来) からも使う。 */
export function compilePatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, 'iu'));
    } catch {
      // 不正な正規表現は無視する。起動を止めない。
    }
  }
  return out;
}

let cached: AppConfig | null = null;

/** 設定を読み込む (プロセス内でキャッシュ)。 */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  // 既定値を置かない。ハッシュタグなし (キーワードのみ、または後から設定) を許すため。
  const hashtags = list('HASHTAGS');
  const keywords = list('KEYWORDS');
  const mode = str('MODERATION_MODE', 'open') === 'approve' ? 'approve' : 'open';

  cached = {
    tenancy: {
      mode: bool('MULTI_TENANT', false) ? 'multi' : 'single',
      dataFile: str('DATA_FILE', './data/wall.db'),
      uploadDir: str('UPLOAD_DIR', './data/uploads'),
    },
    storage: {
      driver: str('STORAGE_DRIVER', 'local') === 's3' ? 's3' : 'local',
      s3: {
        endpoint: str('S3_ENDPOINT', '').replace(/\/+$/, ''),
        // R2 は 'auto'、AWS は 'ap-northeast-1' のようにリージョンを指定する。
        region: str('S3_REGION', 'auto'),
        bucket: str('S3_BUCKET', ''),
        accessKeyId: str('S3_ACCESS_KEY_ID', ''),
        secretAccessKey: str('S3_SECRET_ACCESS_KEY', ''),
        prefix: str('S3_PREFIX', '').replace(/^\/+/, ''),
        publicBaseUrl: str('S3_PUBLIC_BASE_URL', '').replace(/\/+$/, ''),
        forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
      },
    },
    event: {
      id: normalizeSlug(str('EVENT_ID', 'default')) || 'default',
      title: str('EVENT_TITLE', 'Bluesky Live Wall'),
      subtitle: str('EVENT_SUBTITLE', ''),
      showBlueskyLogo: bool('SHOW_BLUESKY_LOGO', true),
      animateTitleGradient: bool('ANIMATE_TITLE_GRADIENT', false),
      hashtags: hashtags.map((t) => t.replace(/^#+/, '')),
      normalizedHashtags: [...new Set(hashtags.map(normalizeTag).filter(Boolean))],
      excludeTerms: buildExcludeTerms(list('EXCLUDE_WORDS')),
      terms: buildTerms([
        ...hashtags.map((v) => ({ value: v, type: 'hashtag' as WatchTermType })),
        ...keywords.map((v) => ({ value: v, type: 'keyword' as WatchTermType })),
      ]),
    },
    server: {
      port: num('PORT', 3000),
      host: str('HOST', '0.0.0.0'),
      logLevel: str('LOG_LEVEL', 'info'),
      trustProxy: bool('TRUST_PROXY', false),
    },
    jetstream: {
      hosts: list('JETSTREAM_HOSTS', [
        'jetstream2.us-east.bsky.network',
        'jetstream1.us-east.bsky.network',
        'jetstream2.us-west.bsky.network',
        'jetstream1.us-west.bsky.network',
      ]),
      reconnectMinMs: num('JETSTREAM_RECONNECT_MIN_MS', 500),
      reconnectMaxMs: num('JETSTREAM_RECONNECT_MAX_MS', 30_000),
      hostFailoverAfter: num('JETSTREAM_HOST_FAILOVER_AFTER', 3),
      replayWindowSec: num('JETSTREAM_REPLAY_WINDOW_SEC', 30),
      // Jetstream の保持期間はおよそ 36 時間。それを超える指定は境界に丸められる。
      startupBackfillMinutes: Math.max(0, Math.min(num('STARTUP_BACKFILL_MINUTES', 0), 2160)),
    },
    buffer: {
      size: num('BUFFER_SIZE', 200),
      backlogSize: num('BACKLOG_SIZE', 40),
    },
    display: {
      maxCards: num('WALL_MAX_CARDS', 40),
      columns: num('WALL_COLUMNS', 1),
      cardTtlSec: num('WALL_CARD_TTL_SEC', 0),
      showImages: bool('SHOW_IMAGES', true),
      showClock: bool('WALL_SHOW_CLOCK', true),
      showSeconds: bool('WALL_SHOW_SECONDS', true),
      showTerms: bool('WALL_SHOW_TERMS', true),
      // キーワードは会場に見せる必要がないため既定で出さない。
      showKeywords: bool('WALL_SHOW_KEYWORDS', false),
    },
    moderation: {
      mode: mode as ModerationMode,
      ngWords: list('NG_WORDS').map((w) => w.toLowerCase()),
      ngPatterns: compilePatterns(list('NG_PATTERNS')),
      ngPatternSources: list('NG_PATTERNS'),
      blockActors: list('BLOCK_ACTORS').map((a) => a.toLowerCase()),
      allowReplies: bool('ALLOW_REPLIES', true),
      filterLabeled: bool('FILTER_LABELED', true),
      allowedLangs: list('ALLOWED_LANGS').map((l) => l.toLowerCase()),
      keywordRequireApproval: bool('KEYWORD_REQUIRE_APPROVAL', true),
    },
    admin: {
      token: str('ADMIN_TOKEN', ''),
      sessionTtlHours: num('ADMIN_SESSION_TTL_HOURS', 12),
      authMode: (['token', 'oauth', 'both'] as const).includes(
        str('AUTH_MODE', 'token') as AuthMode
      )
        ? (str('AUTH_MODE', 'token') as AuthMode)
        : 'token',
      allowedActors: list('ADMIN_ACTORS').map((a) => a.replace(/^@/, '').toLowerCase()),
      systemAdmins: list('SYSTEM_ADMINS').map((a) => a.replace(/^@/, '').toLowerCase()),
    },
    oauth: {
      publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),
      allowHttp: bool('OAUTH_ALLOW_HTTP', false),
    },
    appview: {
      url: str('APPVIEW_URL', 'https://public.api.bsky.app').replace(/\/+$/, ''),
      profileCacheTtlSec: num('PROFILE_CACHE_TTL_SEC', 900),
    },
    feedGenerator: {
      enabled: bool('FEED_GENERATOR_ENABLED', false),
      hostname: str('FEED_GENERATOR_HOSTNAME', ''),
      rkey: str('FEED_GENERATOR_RKEY', 'event-wall'),
      publisherDid: str('FEED_GENERATOR_PUBLISHER_DID', ''),
    },
  };

  return cached;
}
