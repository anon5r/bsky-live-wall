/**
 * システム管理 API (`/api/admin/system/*`)。
 *
 * テナントに属さない (全テナントをまたぐ操作や、テナントが 1 件も無い状態でも
 * 使える操作のため)。`SYSTEM_ADMINS` (`.env`) に載っている DID のみが使える。
 *
 * single モードには「複数テナントを横断する」という概念自体が無く、ここで
 * 提供する操作 (全テナント一覧・任意オーナーでのテナント作成・Jetstream 全体の
 * 切替) はどれも意味を持たない。`createServer` がそもそもこのルートを
 * 登録しない (multi モードのときだけ登録する) ことで 404 にする。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { TenantRegistry } from '../../shared/ingest-contracts.js';
import { createLogger } from '../../shared/logger.js';
import { AdminSessionStore } from '../admin-session.js';
import { badRequest, createAdminAuth, getAuthedDid, routePath } from '../admin-auth.js';
import { isSystemAdmin } from '../permission.js';
import { resolveActor } from '../oauth/client.js';
import type { HubRegistry } from '../hub-registry.js';
import { looksLikeValidId } from './tenants.js';
import { wireTenantBroadcast } from './stream.js';
import { getAuditLog } from './admin.js';

const logger = createLogger('system-admin-routes');

export function registerSystemAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  registry: TenantRegistry,
  sessions: AdminSessionStore,
  hubs: HubRegistry
): void {
  const startedAt = Date.now();
  const adminAuth = createAdminAuth(config, sessions);

  app.addHook('preHandler', (request, reply, done) => {
    // `app` に直接登録するため、`/api/admin/system` 配下だけに絞る。
    if (!routePath(request).includes('/api/admin/system')) {
      done();
      return;
    }
    adminAuth(request, reply);
    done();
  });

  /** システム管理者でなければ 403。応答済みなら true を返す。 */
  const requireSystemAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const did = getAuthedDid(request, sessions);
    if (!isSystemAdmin(did)) {
      reply.code(403).send({ error: 'forbidden', message: 'システム管理者のみ実行できます' });
      return true;
    }
    return false;
  };

  app.get('/api/admin/system/overview', async (request, reply) => {
    if (requireSystemAdmin(request, reply)) return;
    const tenants = registry.list();
    const walls = tenants.reduce((sum, t) => sum + t.getWalls().length, 0);
    return reply.send({
      mode: config.tenancy.mode,
      uptime: Date.now() - startedAt,
      jetstream: registry.hub.getStatus(),
      jetstreamHosts: registry.hub.getHosts(),
      tenants: tenants.length,
      walls,
      sseClients: hubs.size(),
      sessions: sessions.list().length,
    });
  });

  app.get('/api/admin/system/tenants', async (request, reply) => {
    if (requireSystemAdmin(request, reply)) return;
    const tenants = registry.list().map((t) => {
      const meta = t.getTenant();
      return {
        id: t.tenantId,
        name: meta.name,
        ownerDid: meta.ownerDid,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        memberCount: t.listMembers().length,
        wallCount: t.getWalls().length,
      };
    });
    return reply.send({ tenants });
  });

  app.post<{ Body: { id?: unknown; name?: unknown; ownerActor?: unknown } }>(
    '/api/admin/system/tenants',
    async (request, reply) => {
      if (requireSystemAdmin(request, reply)) return;
      const { id, name, ownerActor } = request.body ?? {};
      if (typeof id !== 'string' || !looksLikeValidId(id)) {
        return badRequest(reply, 'id は英数字と "_-" のみ、1〜40 文字で指定してください');
      }
      if (typeof name !== 'string' || name.trim() === '') {
        return badRequest(reply, 'name は空でない文字列で指定してください');
      }
      if (typeof ownerActor !== 'string' || ownerActor.trim() === '') {
        return badRequest(reply, 'ownerActor は空でない文字列で指定してください');
      }
      const owner = await resolveActor(config, ownerActor);
      if (!owner) {
        return badRequest(reply, `オーナーのアカウントを解決できませんでした: ${ownerActor}`);
      }
      try {
        const created = registry.create({
          id,
          name: name.trim(),
          ownerDid: owner.did,
          ownerHandle: owner.handle,
        });
        // 稼働中に作られたテナントは、ここで配線しないと投稿が SSE に届かない
        // (起動時に存在したテナント分は createServer が配線済み)。
        wireTenantBroadcast(created, hubs);
        const requestedBy = getAuthedDid(request, sessions);
        logger.info('システム管理者がテナントを作成しました', {
          id: created.tenantId,
          ownerDid: owner.did,
          by: requestedBy,
        });
        return reply.send({
          tenant: {
            id: created.tenantId,
            name: created.getTenant().name,
            ownerDid: owner.did,
            wallCount: created.getWalls().length,
          },
        });
      } catch (err) {
        return badRequest(reply, err instanceof Error ? err.message : 'テナントを作成できません');
      }
    }
  );

  app.delete<{ Params: { id: string } }>('/api/admin/system/tenants/:id', async (request, reply) => {
    if (requireSystemAdmin(request, reply)) return;
    const tenant = registry.get(request.params.id);
    if (!tenant) {
      return reply.code(404).send({ error: 'tenant_not_found' });
    }
    const ok = registry.remove(request.params.id);
    if (ok) {
      hubs.dropTenant(request.params.id);
      logger.info('システム管理者がテナントを削除しました', {
        id: request.params.id,
        by: getAuthedDid(request, sessions),
      });
    }
    return reply.send({ ok });
  });

  app.post<{ Body: { host?: unknown } }>('/api/admin/system/jetstream', async (request, reply) => {
    if (requireSystemAdmin(request, reply)) return;
    const { host } = request.body ?? {};
    if (typeof host !== 'string' || host === '') {
      return badRequest(reply, 'host は空でない文字列で指定してください');
    }
    const ok = registry.hub.switchHost(host);
    if (!ok) {
      return badRequest(reply, '候補にないホストです');
    }
    logger.info('システム管理者が Jetstream 接続先を切り替えました', {
      host,
      by: getAuthedDid(request, sessions),
    });
    return reply.send({ ok: true, host });
  });

  app.get('/api/admin/system/audit', async (request, reply) => {
    if (requireSystemAdmin(request, reply)) return;
    return reply.send({ entries: getAuditLog() });
  });
}
