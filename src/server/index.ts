/**
 * HTTP / SSE サーバー層のエントリポイント。
 * `src/ingest/` の実装詳細 (WallManager など) は import せず、
 * `src/shared/ingest-contracts.ts` の `TenantRegistry` / `TenantRuntime` にのみ依存する。
 *
 * テナント解決の構造:
 *   - ルート直下 (`/api/...`): single モードでは既定テナント、multi モードでは
 *     テナントを一意に決められないため 404 (`tenant_required`)。
 *   - `/e/:eventId/api/...`: `registry.get(eventId)` で解決。無ければ 404 (`tenant_not_found`)。
 * 解決結果は `request.tenant` (`tenant-context.ts`) に積み、以降のハンドラは
 * `getTenant(request)` で取り出す。テナントに属さない API (ヘルスチェック・
 * OAuth ログイン・テナント一覧など) はこの解決を経由せずルート直下にのみ登録する。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../shared/config.js';
import type { TenantRegistry, TenantRuntime } from '../shared/ingest-contracts.js';
import { createLogger } from '../shared/logger.js';
import { registerAdminRoutes, registerAdminSessionRoutes } from './routes/admin.js';
import { registerActorsRoutes, registerOAuthRoutes } from './routes/oauth.js';
import { AdminSessionStore } from './admin-session.js';
import { registerFeedGeneratorRoutes } from './routes/feed-generator.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPostsRoutes } from './routes/posts.js';
import { registerStreamRoutes, wireTenantBroadcast } from './routes/stream.js';
import { registerTenantsRoutes } from './routes/tenants.js';
import { HubRegistry } from './hub-registry.js';
import { registerStatic } from './static.js';

const logger = createLogger('server');

/** ルート直下 (`/api/...`) のテナント解決。single だけが一意に決まる。 */
function resolveRootTenant(config: AppConfig, registry: TenantRegistry): TenantRuntime | undefined {
  if (config.tenancy.mode !== 'single') return undefined;
  return registry.getDefault();
}

/** Fastify インスタンスを組み立て、全ルートを登録して返す。 */
export async function createServer(config: AppConfig, registry: TenantRegistry): Promise<FastifyInstance> {
  // Fastify 標準ロガーは無効化し、src/shared/logger.ts に統一する。
  // trustProxy を有効にすると request.ip が X-Forwarded-For 由来の
  // 実クライアント IP になる。リバースプロキシ配下では必須。
  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });

  const hubs = new HubRegistry();

  // 起動時点で既にあるテナントの投稿イベントを SSE へ中継できるようにする。
  // (稼働中に作られたテナントは routes/tenants.ts が個別に配線する)
  for (const tenant of registry.list()) wireTenantBroadcast(tenant, hubs);

  // 管理セッションはトークンログインと OAuth ログインで共有する。
  const sessions = new AdminSessionStore(config.admin.sessionTtlHours);

  // API はキャッシュさせない。イベント階層付きの経路も対象にする。
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url.includes('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    done();
  });

  // ---- テナントに属さない経路 ----
  // OAuth の client_id とフィードの did:web は固定 URL である必要があるため、
  // 階層を付けずにルート直下へ置く。ヘルスチェック・セッション管理・テナント
  // 一覧もテナント解決の対象にしない (解決できない/する必要が無いため)。
  const oauthRuntime = await registerOAuthRoutes(app, config, sessions);
  registerHealthRoutes(app, registry, hubs);
  registerAdminSessionRoutes(app, config, sessions);
  registerTenantsRoutes(app, config, registry, sessions, hubs);

  /**
   * テナントに属する API。素の `/api/...` と `/e/<eventId>/api/...` の
   * 両方に同じ内容を登録する。呼び出し前提として `request.tenant` が
   * 積まれていること (呼び出し元の `onRequest` フックが保証する)。
   */
  const tenantScopedApi = async (instance: FastifyInstance): Promise<void> => {
    registerStreamRoutes(instance, config, hubs);
    registerPostsRoutes(instance);
    registerAdminRoutes(instance, config, sessions);
    // OAuth が無効な構成 (AUTH_MODE=token) では許可リストの概念自体が無い。
    if (oauthRuntime) registerActorsRoutes(instance, config, sessions, oauthRuntime);
  };

  // ルート直下。single モードでは既定テナントとして解決する。
  // multi モードはテナントを一意に決められないため 404 にする
  // (テナントが 0 件でも `resolveRootTenant` 自体は例外を投げない)。
  await app.register(async (instance) => {
    instance.addHook('onRequest', (request, reply, done) => {
      const tenant = resolveRootTenant(config, registry);
      if (!tenant) {
        reply.code(404).send({ error: 'tenant_required' });
        return;
      }
      request.tenant = tenant;
      done();
    });
    await tenantScopedApi(instance);
  });

  // イベントを明示する経路。`registry.get()` で解決できなければ 404。
  await app.register(
    async (instance) => {
      instance.addHook('onRequest', (request, reply, done) => {
        const { eventId } = request.params as { eventId?: string };
        const tenant = eventId ? registry.get(eventId) : undefined;
        if (!tenant) {
          reply.code(404).send({ error: 'tenant_not_found' });
          return;
        }
        request.tenant = tenant;
        done();
      });
      await tenantScopedApi(instance);
    },
    { prefix: '/e/:eventId' }
  );

  if (config.feedGenerator.enabled) {
    // multi モードでは起動時に拒否している (src/index.ts) ため、ここに来る時点で single 確定。
    registerFeedGeneratorRoutes(app, config, registry.getDefault());
    logger.info('フィードジェネレータを有効化しました', {
      hostname: config.feedGenerator.hostname,
    });
  }

  await registerStatic(app, registry, config.tenancy.mode);

  app.addHook('onClose', (_instance, done) => {
    hubs.closeAll();
    done();
  });

  return app;
}
