/**
 * `GET /api/auth/me`。管理画面がログイン状態 (誰か・どのテナントを操作できるか) を
 * 把握するための経路。テナントに属さない (ログイン後にどのテナントを見るかを
 * まだ決めていない段階で呼ばれるため、テナント解決の対象にできない)。
 *
 * ログイン済みでなくても 200 を返す (`authenticated: false`)。ログイン状態を
 * 聞いているだけであり、認証を要求する操作ではないため 401 にはしない。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { TenantRegistry } from '../../shared/ingest-contracts.js';
import { AdminSessionStore, SESSION_COOKIE, readCookie } from '../admin-session.js';
import { getAuthedDid, isAdminAuthenticated } from '../admin-auth.js';
import { isSystemAdmin } from '../permission.js';

export function registerAuthMeRoute(
  app: FastifyInstance,
  config: AppConfig,
  registry: TenantRegistry,
  sessions: AdminSessionStore
): void {
  app.get('/api/auth/me', async (request, reply) => {
    if (!isAdminAuthenticated(config, sessions, request)) {
      return reply.send({ authenticated: false });
    }

    const session = sessions.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
    const did = getAuthedDid(request, sessions);
    const handle = session?.handle ?? null;
    const systemAdmin = isSystemAdmin(did);

    if (config.tenancy.mode === 'single') {
      const tenant = registry.getDefault();
      return reply.send({
        authenticated: true,
        did: did ?? null,
        handle,
        isSystemAdmin: systemAdmin,
        mode: 'single' as const,
        tenants: [{ id: tenant.tenantId, name: tenant.getTenant().name, role: 'owner' as const }],
      });
    }

    // multi モード。システム管理者には全テナントを role: 'system' で返す。
    // DID を伴わないトークン/loopback ログインは、どのテナントの誰かを特定できないため
    // テナント一覧は空になる (システム管理者判定も同様に成立しない)。
    const tenants = systemAdmin
      ? registry.list().map((t) => ({ id: t.tenantId, name: t.getTenant().name, role: 'system' as const }))
      : did
        ? registry.listForDid(did).map((t) => ({
            id: t.tenantId,
            name: t.getTenant().name,
            role: t.getMemberRole(did) ?? ('moderator' as const),
          }))
        : [];

    return reply.send({
      authenticated: true,
      did: did ?? null,
      handle,
      isSystemAdmin: systemAdmin,
      mode: 'multi' as const,
      tenants,
    });
  });
}
