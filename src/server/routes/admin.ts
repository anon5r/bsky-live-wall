/**
 * 運営用管理 API。
 *
 * 認証: `Authorization: Bearer <ADMIN_TOKEN>`。
 * `ADMIN_TOKEN` が空文字の場合は loopback アドレスからのアクセスのみ許可する。
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

    if (token === '') {
      // トークン未設定時は loopback のみ許可。
      const ip = request.ip;
      if (!isLoopback(ip)) {
        logger.warn('loopback 以外からの管理 API アクセスを拒否', { ip });
        unauthorized(reply);
      }
      return;
    }

    const header = request.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !match[1] || !tokenMatches(match[1], token)) {
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
    return reply.send({ state, recent, pending });
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

  app.post('/api/admin/clear', async (_request, reply) => {
    source.clear();
    return reply.send({ ok: true });
  });
}
