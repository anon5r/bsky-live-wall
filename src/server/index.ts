/**
 * HTTP / SSE サーバー層のエントリポイント。
 * `src/ingest/` は一切 import しない。`WallSource` インターフェースのみに依存する。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../shared/config.js';
import type { WallSource } from '../shared/contracts.js';
import { createLogger } from '../shared/logger.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { AdminSessionStore } from './admin-session.js';
import { registerFeedGeneratorRoutes } from './routes/feed-generator.js';
import { registerPostsRoutes } from './routes/posts.js';
import { registerStreamRoutes } from './routes/stream.js';
import { HubRegistry } from './hub-registry.js';
import { registerStatic } from './static.js';

const logger = createLogger('server');

/** Fastify インスタンスを組み立て、全ルートを登録して返す。 */
export async function createServer(config: AppConfig, source: WallSource): Promise<FastifyInstance> {
  // Fastify 標準ロガーは無効化し、src/shared/logger.ts に統一する。
  // trustProxy を有効にすると request.ip が X-Forwarded-For 由来の
  // 実クライアント IP になる。リバースプロキシ配下では必須。
  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });

  const hubs = new HubRegistry();

  // 管理セッションはトークンログインと OAuth ログインで共有する。
  const sessions = new AdminSessionStore(config.admin.sessionTtlHours);

  // API はキャッシュさせない。イベント階層付きの経路も対象にする。
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url.includes('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    done();
  });

  /**
   * イベント (テナント) に属する API。
   * 素の `/api/...` と、イベントを明示する `/e/<eventId>/api/...` の
   * 両方に同じ内容を登録する。将来テナントが増えても経路を変えずに済むよう、
   * 1 イベントしかない現段階から階層を用意しておく。
   */
  const eventScopedApi = async (instance: FastifyInstance): Promise<void> => {
    registerStreamRoutes(instance, config, source, hubs);
    registerPostsRoutes(instance, config, source, hubs);
    registerAdminRoutes(instance, config, source, sessions);
  };

  await app.register(eventScopedApi);
  await app.register(
    async (instance) => {
      // 存在しないイベントを指した経路は 404 にする。
      // 現状は 1 イベントのみだが、判定をここに置いておけば
      // テナントが増えたときに参照先を差し替えるだけで済む。
      instance.addHook('onRequest', (request, reply, done) => {
        const { eventId } = request.params as { eventId?: string };
        if (eventId !== config.event.id) {
          reply.code(404).send({ error: 'event_not_found' });
          return;
        }
        done();
      });
      await eventScopedApi(instance);
    },
    { prefix: '/e/:eventId' }
  );

  // イベントに属さない経路。OAuth の client_id とフィードの did:web は
  // 固定 URL である必要があるため、階層を付けずにルート直下へ置く。
  await registerOAuthRoutes(app, config, sessions);

  if (config.feedGenerator.enabled) {
    registerFeedGeneratorRoutes(app, config, source);
    logger.info('フィードジェネレータを有効化しました', {
      hostname: config.feedGenerator.hostname,
    });
  }

  await registerStatic(app, config.event.id, config.tenancy.mode);

  app.addHook('onClose', (_instance, done) => {
    hubs.closeAll();
    done();
  });

  return app;
}
