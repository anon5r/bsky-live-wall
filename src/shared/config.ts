import 'dotenv/config';
import type { ModerationMode } from './types.js';

/** 環境変数から組み立てるアプリケーション設定。既定値はすべてここで一元管理する。 */
export interface AppConfig {
  event: {
    title: string;
    subtitle: string;
    hashtags: string[];
    /** 比較用に正規化 (NFKC + 小文字 + 先頭 # 除去) 済みのタグ */
    normalizedHashtags: string[];
  };
  server: {
    port: number;
    host: string;
    logLevel: string;
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
  };
  moderation: {
    mode: ModerationMode;
    ngWords: string[];
    ngPatterns: RegExp[];
    blockActors: string[];
    allowReplies: boolean;
    filterLabeled: boolean;
    allowedLangs: string[];
  };
  admin: {
    token: string;
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

function compilePatterns(sources: string[]): RegExp[] {
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

  const hashtags = list('HASHTAGS', ['bskyevent']);
  const mode = str('MODERATION_MODE', 'open') === 'approve' ? 'approve' : 'open';

  cached = {
    event: {
      title: str('EVENT_TITLE', 'Bluesky Live Wall'),
      subtitle: str('EVENT_SUBTITLE', ''),
      hashtags: hashtags.map((t) => t.replace(/^#+/, '')),
      normalizedHashtags: [...new Set(hashtags.map(normalizeTag).filter(Boolean))],
    },
    server: {
      port: num('PORT', 3000),
      host: str('HOST', '0.0.0.0'),
      logLevel: str('LOG_LEVEL', 'info'),
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
      startupBackfillMinutes: Math.max(0, Math.min(num('STARTUP_BACKFILL_MINUTES', 120), 2160)),
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
    },
    moderation: {
      mode: mode as ModerationMode,
      ngWords: list('NG_WORDS').map((w) => w.toLowerCase()),
      ngPatterns: compilePatterns(list('NG_PATTERNS')),
      blockActors: list('BLOCK_ACTORS').map((a) => a.toLowerCase()),
      allowReplies: bool('ALLOW_REPLIES', true),
      filterLabeled: bool('FILTER_LABELED', true),
      allowedLangs: list('ALLOWED_LANGS').map((l) => l.toLowerCase()),
    },
    admin: {
      token: str('ADMIN_TOKEN', ''),
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
