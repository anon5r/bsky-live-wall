/**
 * 管理 API 共通の認証。`routes/admin.ts` から抜き出し、テナント非依存の管理系
 * ルート (`routes/tenants.ts` のテナント一覧・作成・削除、`routes/oauth.ts` の
 * アカウント許可リスト) からも同じ判定を使えるようにする。
 *
 * 認証は 2 経路。
 * - **セッション Cookie** (管理画面が使う): ログイン時に一度だけトークンを検証し、
 *   HttpOnly Cookie でセッション ID を渡す。
 * - **Bearer トークン** (スクリプト・監視用): `Authorization: Bearer <ADMIN_TOKEN>`。
 *
 * `ADMIN_TOKEN` が空文字の場合は loopback アドレスからのアクセスのみ許可する。
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { AdminSessionStore, SESSION_COOKIE, readCookie } from './admin-session.js';

const logger = createLogger('admin-auth');

/**
 * 認証判定に使う経路を返す。
 *
 * 管理系ルートは `/api/...` と `/e/<eventId>/api/...` の両方に登録され、
 * かつ他の経路 (ヘルスチェックなど) と同じ Fastify インスタンスに同居することが
 * あるため、`request.url` の前方一致で判定すると、プレフィックス付きの経路や
 * 同居する無関係な経路まで認証ガードに巻き込んでしまう。登録時のルート
 * パターンを優先して使う。
 */
export function routePath(request: FastifyRequest): string {
  const pattern = request.routeOptions?.url;
  if (typeof pattern === 'string' && pattern !== '') return pattern;
  return request.url.split('?')[0] ?? '';
}

/** リモートアドレスが loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) かどうか判定する。 */
function isLoopback(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || ip === '::1';
}

/** 定数時間比較でトークンを検証する。長さが異なる場合は即座に false。 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 認証失敗の総当たり対策。IP ごとに失敗回数を数える。管理系ルート全体で共有する。 */
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;
const AUTH_FAIL_LIMIT = 10;
const authFailures = new Map<string, { count: number; resetAt: number }>();

export function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
    return;
  }
  entry.count += 1;
  // 際限なく増えないよう、期限切れのエントリを間引く。
  if (authFailures.size > 1000) {
    for (const [key, value] of authFailures) {
      if (value.resetAt <= now) authFailures.delete(key);
    }
  }
}

export function isRateLimited(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= AUTH_FAIL_LIMIT;
}

export function tooManyRequests(reply: FastifyReply): FastifyReply {
  return reply.code(429).send({ error: 'too_many_requests' });
}

export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'unauthorized' });
}

export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', message });
}

/**
 * 管理 API の認証本体。セッション Cookie -> Bearer トークン -> (トークン未設定時のみ) loopback
 * の順に確認する。通れば何もせず戻り、通らなければ `reply` へエラーを書き込む。
 */
export function createAdminAuth(config: AppConfig, sessions: AdminSessionStore) {
  const tokenAuthEnabled = config.admin.authMode === 'token' || config.admin.authMode === 'both';

  return function adminAuth(request: FastifyRequest, reply: FastifyReply): void {
    const token = config.admin.token;
    const ip = request.ip;

    if (isRateLimited(ip)) {
      logger.warn('管理 API の認証失敗が続いたため一時的に拒否', { ip });
      tooManyRequests(reply);
      return;
    }

    // 1. セッション Cookie。トークンログイン・OAuth ログインの両方がこれを使う。
    const session = sessions.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (session) {
      // Cookie 認証は CSRF の対象になる。SameSite に加えて、
      // クロスオリジンからは付与できないカスタムヘッダを状態変更操作に要求する。
      if (request.method !== 'GET' && request.headers['x-requested-with'] !== 'bsky-live-wall') {
        badRequest(reply, 'X-Requested-With ヘッダが必要です');
      }
      return;
    }

    // 2. これ以降はトークンによる認証。AUTH_MODE=oauth では一切認めない。
    //    loopback 例外もトークン方式の利便機能であり、OAuth 専用モードでは適用しない。
    if (!tokenAuthEnabled) {
      recordAuthFailure(ip);
      unauthorized(reply);
      return;
    }

    // 3. トークン未設定時の loopback 例外 (会場 PC での単独運用向け)。
    //    プロキシ配下ではリモートの利用者も loopback に見えるため無効化する。
    if (token === '') {
      if (config.server.trustProxy) {
        // 起動時に弾いているはずだが二重に防ぐ。
        logger.error('TRUST_PROXY=true では ADMIN_TOKEN が必須です');
        unauthorized(reply);
        return;
      }
      if (!isLoopback(ip)) {
        logger.warn('loopback 以外からの管理 API アクセスを拒否', { ip });
        recordAuthFailure(ip);
        unauthorized(reply);
      }
      return;
    }

    // 4. Bearer トークン (スクリプト・監視用)
    const header = request.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !match[1] || !tokenMatches(match[1], token)) {
      recordAuthFailure(ip);
      unauthorized(reply);
    }
  };
}

/**
 * 現在のリクエストを行っている DID。OAuth ログインのセッション Cookie にしか乗らない。
 * Bearer トークンやトークンログイン (loopback 例外含む) には DID が無い。
 */
export function getAuthedDid(request: FastifyRequest, sessions: AdminSessionStore): string | undefined {
  const session = sessions.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
  return session?.did;
}
