/**
 * テナントの一覧・作成・削除 (`/api/admin/tenants*`)。
 *
 * テナントに属さない API (どのテナントを見る前の「そもそもどのテナントを
 * 操作できるか」を答える経路のため、テナント解決の対象にできない)。
 * `createServer` からルート直下にのみ登録する。
 *
 * 認証は他の管理 API と同じ `createAdminAuth` を使うが、テナントの
 * メンバーかどうかの判定 (`checkTenantPermission`) はここでは使わない。
 * 一覧はログイン中の DID が持つテナントに絞り込むことで、作成は
 * 「作成者がオーナーになる」ことで、削除は「対象テナントの owner か」を
 * `TenantRuntime.getMemberRole` で直接確認することで、それぞれ完結する。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { TenantRegistry } from '../../shared/ingest-contracts.js';
import { createLogger } from '../../shared/logger.js';
import { AdminSessionStore, SESSION_COOKIE, readCookie } from '../admin-session.js';
import { badRequest, createAdminAuth, getAuthedDid, routePath } from '../admin-auth.js';
import type { HubRegistry } from '../hub-registry.js';
import { wireTenantBroadcast } from './stream.js';

const logger = createLogger('tenants-routes');

/** テナント ID に使える文字種。config.ts の `normalizeSlug` と同じ規則。 `routes/system.ts` からも使う。 */
export function looksLikeValidId(id: string): boolean {
  return /^[a-z0-9_-]{1,40}$/.test(id);
}

export function registerTenantsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  registry: TenantRegistry,
  sessions: AdminSessionStore,
  hubs: HubRegistry
): void {
  const adminAuth = createAdminAuth(config, sessions);

  app.addHook('preHandler', (request, reply, done) => {
    // `app` に直接登録するため、他の経路 (ヘルスチェック・OAuth ログイン等) に
    // 認証がかからないよう `/api/admin/tenants` 配下だけに絞る。
    if (!routePath(request).includes('/api/admin/tenants')) {
      done();
      return;
    }
    adminAuth(request, reply);
    done();
  });

  /**
   * ログイン中の DID が操作できるテナントの一覧。
   * single モードでは常に既定テナント 1 件 (メンバーの概念を使わないため)。
   * multi モードでは DID が無ければ (Bearer トークン等) 空配列を返す。
   */
  app.get('/api/admin/tenants', async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.tenancy.mode === 'single') {
      const tenant = registry.getDefault();
      return reply.send({
        tenants: [
          {
            id: tenant.tenantId,
            name: tenant.getTenant().name,
            wallCount: tenant.getWalls().length,
            isMember: true,
            role: 'owner' as const,
          },
        ],
      });
    }

    const did = getAuthedDid(request, sessions);
    if (!did) {
      return reply.send({ tenants: [] });
    }
    const tenants = registry.listForDid(did).map((t) => ({
      id: t.tenantId,
      name: t.getTenant().name,
      wallCount: t.getWalls().length,
      isMember: true,
      role: t.getMemberRole(did) ?? ('moderator' as const),
    }));
    return reply.send({ tenants });
  });

  /** テナントの作成。multi モードのみ。作成者がオーナーになる。 */
  app.post<{ Body: { id?: unknown; name?: unknown } }>(
    '/api/admin/tenants',
    async (request, reply) => {
      if (config.tenancy.mode !== 'multi') {
        return badRequest(reply, '単一テナント運用ではテナントを作成できません');
      }
      const did = getAuthedDid(request, sessions);
      if (!did) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'テナントの作成には OAuth ログインが必要です' });
      }
      const session = sessions.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
      const handle = session?.handle ?? did;

      const { id, name } = request.body ?? {};
      if (typeof id !== 'string' || !looksLikeValidId(id)) {
        return badRequest(reply, 'id は英数字と "_-" のみ、1〜40 文字で指定してください');
      }
      if (typeof name !== 'string' || name.trim() === '') {
        return badRequest(reply, 'name は空でない文字列で指定してください');
      }

      try {
        const created = registry.create({ id, name: name.trim(), ownerDid: did, ownerHandle: handle });
        // 新規テナントの投稿イベントを SSE へ中継できるようにする。
        // 起動時に存在したテナント分は createServer 側で配線済みだが、
        // 稼働中に作られたテナントはここで配線しないと投稿が画面に届かない。
        wireTenantBroadcast(created, hubs);
        logger.info('テナントを作成しました', { id: created.tenantId, ownerDid: did });
        return reply.send({
          tenant: {
            id: created.tenantId,
            name: created.getTenant().name,
            wallCount: created.getWalls().length,
            isMember: true,
            role: 'owner' as const,
          },
        });
      } catch (err) {
        return badRequest(reply, err instanceof Error ? err.message : 'テナントを作成できません');
      }
    }
  );

  /** テナントの削除。owner のみ。multi モードのみ。 */
  app.delete<{ Params: { id: string } }>('/api/admin/tenants/:id', async (request, reply) => {
    if (config.tenancy.mode !== 'multi') {
      return badRequest(reply, '単一テナント運用ではテナントを削除できません');
    }
    const tenant = registry.get(request.params.id);
    if (!tenant) {
      return reply.code(404).send({ error: 'tenant_not_found' });
    }
    const did = getAuthedDid(request, sessions);
    // Bearer など DID が無い経路には、どのテナントの owner かを判定できないため一律で拒否する。
    if (!did || tenant.getMemberRole(did) !== 'owner') {
      return reply.code(403).send({ error: 'forbidden', message: 'この操作はオーナーのみ実行できます' });
    }
    const ok = registry.remove(request.params.id);
    if (ok) {
      hubs.dropTenant(request.params.id);
      logger.info('テナントを削除しました', { id: request.params.id, by: did });
    }
    return reply.send({ ok });
  });
}
