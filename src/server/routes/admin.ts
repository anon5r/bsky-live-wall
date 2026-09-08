/**
 * 運営用管理 API。
 *
 * 認証は 2 経路。
 * - **セッション Cookie** (管理画面が使う): ログイン時に一度だけトークンを検証し、
 *   HttpOnly Cookie でセッション ID を渡す。トークンをブラウザに保存しない。
 * - **Bearer トークン** (スクリプト・監視用): `Authorization: Bearer <ADMIN_TOKEN>`。
 *
 * `ADMIN_TOKEN` が空文字の場合は loopback アドレスからのアクセスのみ許可する。
 * ただし `TRUST_PROXY=true` (リバースプロキシ配下) では、リモートの利用者が
 * プロキシの loopback アドレスとして見えるため、この例外を無効化しトークンを必須とする。
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { WallSource } from '../../shared/contracts.js';
import { createLogger } from '../../shared/logger.js';
import {
  AdminSessionStore,
  SESSION_COOKIE,
  readCookie,
  safeEqual,
} from '../admin-session.js';

const logger = createLogger('admin');

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

/** 認証失敗の総当たり対策。IP ごとに失敗回数を数える。 */
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;
const AUTH_FAIL_LIMIT = 10;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function recordAuthFailure(ip: string): void {
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

function isRateLimited(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= AUTH_FAIL_LIMIT;
}

function tooManyRequests(reply: FastifyReply): FastifyReply {
  return reply.code(429).send({ error: 'too_many_requests' });
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'unauthorized' });
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', message });
}

/** 監査ログ。誰がいつ何をしたかを追えるようにする。 */
const AUDIT_LIMIT = 200;

interface AuditEntry {
  at: number;
  action: string;
  detail: string;
  ip: string;
  /** セッション ID の先頭のみ。完全な ID はログに残さない。 */
  actor: string;
}

const auditLog: AuditEntry[] = [];

function recordAudit(
  action: string,
  detail: string,
  request: FastifyRequest,
  actorOverride?: string
): void {
  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
  // ログイン時点ではまだ Cookie が無いため、呼び出し側から actor を渡せるようにする。
  const actor = actorOverride ?? (sessionId ? `session:${sessionId.slice(0, 8)}` : 'bearer');
  auditLog.unshift({ at: Date.now(), action, detail, ip: request.ip, actor });
  if (auditLog.length > AUDIT_LIMIT) auditLog.length = AUDIT_LIMIT;
  logger.info(`管理操作: ${action}`, { detail, ip: request.ip, actor });
}

export function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  source: WallSource,
): void {
  const sessions = new AdminSessionStore(config.admin.sessionTtlHours);

  /**
   * ログイン不要で通してよい経路 (ログイン API 自身のみ)。
   * startsWith にすると /api/admin/sessions/revoke-all まで素通りするため、
   * クエリを除いた完全一致で判定する。
   */
  const isLoginRoute = (request: FastifyRequest): boolean => {
    const path = request.url.split('?')[0];
    return path === '/api/admin/session' && request.method === 'POST';
  };

  const adminAuth = (request: FastifyRequest, reply: FastifyReply): void => {
    const token = config.admin.token;
    const ip = request.ip;

    if (isRateLimited(ip)) {
      logger.warn('管理 API の認証失敗が続いたため一時的に拒否', { ip });
      tooManyRequests(reply);
      return;
    }

    // トークン未設定時の loopback 例外。
    // プロキシ配下ではリモートの利用者も loopback に見えるため無効化する。
    if (token === '' && !config.server.trustProxy) {
      if (!isLoopback(ip)) {
        logger.warn('loopback 以外からの管理 API アクセスを拒否', { ip });
        recordAuthFailure(ip);
        unauthorized(reply);
      }
      return;
    }

    if (token === '') {
      // TRUST_PROXY=true かつトークン未設定。起動時に弾いているはずだが二重に防ぐ。
      logger.error('TRUST_PROXY=true では ADMIN_TOKEN が必須です');
      unauthorized(reply);
      return;
    }

    // 1. セッション Cookie (管理画面)
    const session = sessions.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (session) {
      // Cookie 認証は CSRF の対象になる。SameSite=Strict に加えて、
      // クロスオリジンからは付与できないカスタムヘッダを状態変更操作に要求する。
      if (request.method !== 'GET' && request.headers['x-requested-with'] !== 'bsky-live-wall') {
        badRequest(reply, 'X-Requested-With ヘッダが必要です');
      }
      return;
    }

    // 2. Bearer トークン (スクリプト・監視用)
    const header = request.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !match[1] || !tokenMatches(match[1], token)) {
      recordAuthFailure(ip);
      unauthorized(reply);
    }
  };

  app.addHook('preHandler', (request, reply, done) => {
    if (!request.url.startsWith('/api/admin')) {
      done();
      return;
    }
    if (isLoginRoute(request)) {
      done();
      return;
    }
    adminAuth(request, reply);
    done();
  });

  // ---- セッション ----

  app.post<{ Body: { token?: unknown } }>('/api/admin/session', async (request, reply) => {
    const ip = request.ip;
    if (isRateLimited(ip)) {
      logger.warn('ログイン試行が続いたため一時的に拒否', { ip });
      return tooManyRequests(reply);
    }

    const configured = config.admin.token;
    const { token } = request.body ?? {};

    // トークン未設定 (loopback 限定運用) の場合はトークン検証を省く。
    // ここへ到達している時点で loopback からのアクセスであることは
    // preHandler より前の isLoginRoute 経路で保証されないため、改めて判定する。
    if (configured === '') {
      if (config.server.trustProxy || !isLoopback(ip)) {
        recordAuthFailure(ip);
        return unauthorized(reply);
      }
    } else if (typeof token !== 'string' || !safeEqual(token, configured)) {
      recordAuthFailure(ip);
      return unauthorized(reply);
    }

    const session = sessions.create(ip, String(request.headers['user-agent'] ?? ''));
    // Secure は HTTPS のときだけ付ける。localhost の HTTP 運用を壊さないため。
    const secure = request.protocol === 'https';
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessions.ttlSeconds}` +
        (secure ? '; Secure' : '')
    );
    recordAudit(
      'login',
      `expiresAt=${new Date(session.expiresAt).toISOString()}`,
      request,
      `session:${session.id.slice(0, 8)}`
    );
    return reply.send({ ok: true, expiresAt: session.expiresAt });
  });

  app.delete('/api/admin/session', async (request, reply) => {
    const id = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (id) sessions.revoke(id);
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    recordAudit('logout', '', request);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/sessions', async (_request, reply) => {
    // セッション ID そのものは返さない。
    const list = sessions.list().map((s) => ({
      idPrefix: s.id.slice(0, 8),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
    }));
    return reply.send({ sessions: list, ttlHours: config.admin.sessionTtlHours });
  });

  app.post('/api/admin/sessions/revoke-all', async (request, reply) => {
    const revoked = sessions.revokeAll();
    reply.header(`Set-Cookie`, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    recordAudit('revoke-all-sessions', `${revoked} 件`, request);
    return reply.send({ revoked });
  });

  app.get('/api/admin/audit', async (_request, reply) => {
    return reply.send({ entries: auditLog });
  });

  // ---- 状態と操作 ----

  app.get('/api/admin/state', async (_request, reply) => {
    const state = source.getState();
    const recent = source.getRecent(config.buffer.backlogSize);
    const pending = source.getPending(config.buffer.backlogSize);
    const hidden = source.getHidden(config.buffer.backlogSize);
    const blocked = source.getBlockedActors();
    return reply.send({ state, recent, pending, hidden, blocked });
  });

  app.post<{ Body: { paused?: unknown } }>('/api/admin/pause', async (request, reply) => {
    const { paused } = request.body ?? {};
    if (typeof paused !== 'boolean') {
      return badRequest(reply, 'paused は boolean で指定してください');
    }
    recordAudit('pause', String(paused), request);
    const state = source.setPaused(paused);
    return reply.send({ state });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/hide', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('hide', uri, request);
    const ok = source.hide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/unhide', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('unhide', uri, request);
    const ok = source.unhide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/approve', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('approve', uri, request);
    const ok = source.approve(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/block', async (request, reply) => {
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    recordAudit('block', did, request);
    const removed = source.blockActor(did);
    return reply.send({ removed });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/unblock', async (request, reply) => {
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    recordAudit('unblock', did, request);
    const restored = source.unblockActor(did);
    return reply.send({ restored });
  });

  app.post('/api/admin/clear', async (request, reply) => {
    recordAudit('clear', '', request);
    source.clear();
    return reply.send({ ok: true });
  });
}
