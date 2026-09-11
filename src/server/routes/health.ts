/**
 * GET /api/health: テナントに属さない (テナント解決をしない) ヘルスチェック。
 *
 * multi モードはテナントが 0 件でも起動できる必要があり、ヘルスチェックが
 * 特定テナントの状態に依存すると「テナントが無いと死活監視も動かない」という
 * 本末転倒になる。そのため個別テナントではなく、全テナント共有の `IngestHub`
 * (Jetstream 接続状態) とテナント数を返す。
 */
import type { FastifyInstance } from 'fastify';
import type { TenantRegistry } from '../../shared/ingest-contracts.js';
import type { HubRegistry } from '../hub-registry.js';

export function registerHealthRoutes(app: FastifyInstance, registry: TenantRegistry, hubs: HubRegistry): void {
  const startedAt = Date.now();

  app.get('/api/health', async (_request, reply) => {
    const tenants = registry.list();
    const walls = tenants.reduce((sum, t) => sum + t.getWalls().length, 0);
    return reply.send({
      ok: true,
      uptime: Date.now() - startedAt,
      sseClients: hubs.size(),
      tenants: tenants.length,
      walls,
      jetstream: registry.hub.getStatus(),
    });
  });
}
