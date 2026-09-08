/**
 * 運営用管理 API。
 *
 * 認証: `Authorization: Bearer <ADMIN_TOKEN>`。
 * `ADMIN_TOKEN` が空文字の場合は loopback アドレスからのアクセスのみ許可する。
 * ただし `TRUST_PROXY=true` (リバースプロキシ配下) では、リモートの利用者が
 * プロキシの loopback アドレスとして見えるため、この例外を無効化しトークンを必須とする。
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { WallSource } from '../../shared/contracts.js';
import { createLogger } from '../../shared/logger.js';

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

export function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  source: WallSource,
): void {
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
    adminAuth(request, reply);
    done();
  });

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
    const state = source.setPaused(paused);
    return reply.send({ state });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/hide', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    const ok = source.hide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/unhide', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    const ok = source.unhide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/approve', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    const ok = source.approve(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/block', async (request, reply) => {
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    const removed = source.blockActor(did);
    return reply.send({ removed });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/unblock', async (request, reply) => {
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    const restored = source.unblockActor(did);
    return reply.send({ restored });
  });

  app.post('/api/admin/clear', async (_request, reply) => {
    source.clear();
    return reply.send({ ok: true });
  });
}
