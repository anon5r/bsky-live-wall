/**
 * 投稿一覧 / 状態 / ヘルスチェック API。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { WallSource } from '../../shared/contracts.js';
import type { SseHub } from '../sse-hub.js';

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(n)));
}

export function registerPostsRoutes(
  app: FastifyInstance,
  _config: AppConfig,
  source: WallSource,
  hub: SseHub,
): void {
  const startedAt = Date.now();

  app.get<{ Querystring: { limit?: string } }>('/api/posts', async (request, reply) => {
    const limit = clampLimit(request.query.limit);
    const posts = source.getRecent(limit);
    const stats = source.getState().stats;
    return reply.send({ posts, stats });
  });

  app.get('/api/state', async (_request, reply) => {
    return reply.send(source.getState());
  });

  app.get('/api/health', async (_request, reply) => {
    const state = source.getState();
    return reply.send({
      ok: true,
      uptime: Date.now() - startedAt,
      sseClients: hub.size(),
      jetstream: state.jetstream,
    });
  });
}
