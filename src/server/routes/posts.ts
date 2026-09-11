/**
 * 投稿一覧 / 状態 API。ウォールを `?wall=<id>` で指定できる。省略時は既定ウォール。
 * ヘルスチェック (`/api/health`) はテナントに属さないため `routes/health.ts` にある。
 */
import type { FastifyInstance } from 'fastify';
import type { WallHandle, WallSource } from '../../shared/contracts.js';
import { getTenant } from '../tenant-context.js';

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(n)));
}

/** `?wall=` からウォールを解決する。省略時は既定ウォール。 */
export function resolveWall(source: WallSource, id: string | undefined): WallHandle | undefined {
  return id ? source.getWall(id) : source.getDefaultWall();
}

export function registerPostsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string; wall?: string } }>(
    '/api/posts',
    async (request, reply) => {
      const tenant = getTenant(request);
      const wall = resolveWall(tenant, request.query.wall);
      if (!wall) return reply.code(404).send({ error: 'wall_not_found' });
      const limit = clampLimit(request.query.limit);
      return reply.send({ posts: wall.getRecent(limit), stats: wall.getState().stats });
    }
  );

  app.get<{ Querystring: { wall?: string } }>('/api/state', async (request, reply) => {
    const tenant = getTenant(request);
    const wall = resolveWall(tenant, request.query.wall);
    if (!wall) return reply.code(404).send({ error: 'wall_not_found' });
    return reply.send(wall.getState());
  });

  /** 会場モニターの切り替え用。認証なしで開けるウォールの一覧。 */
  app.get('/api/walls', async (request, reply) => {
    const tenant = getTenant(request);
    return reply.send({
      walls: tenant.getWalls().map((w) => ({
        id: w.id,
        name: w.name,
        terms: w.terms,
        postCount: w.postCount,
        isDefault: w.isDefault,
      })),
    });
  });
}
