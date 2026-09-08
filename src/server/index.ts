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
import { SseHub } from './sse-hub.js';
import { registerStatic } from './static.js';

const logger = createLogger('server');

/** Fastify インスタンスを組み立て、全ルートを登録して返す。 */
export async function createServer(config: AppConfig, source: WallSource): Promise<FastifyInstance> {
  // Fastify 標準ロガーは無効化し、src/shared/logger.ts に統一する。
  // trustProxy を有効にすると request.ip が X-Forwarded-For 由来の
  // 実クライアント IP になる。リバースプロキシ配下では必須。
  const app = Fastify({ logger: false, trustProxy: config.server.trustProxy });

  const hub = new SseHub();

  // 管理セッションはトークンログインと OAuth ログインで共有する。
  const sessions = new AdminSessionStore(config.admin.sessionTtlHours);

  // `/api/*` は SSE も含めキャッシュさせない。
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    done();
  });

  registerStreamRoutes(app, config, source, hub);
  registerPostsRoutes(app, config, source, hub);
  registerAdminRoutes(app, config, source, sessions);
  await registerOAuthRoutes(app, config, sessions);

  if (config.feedGenerator.enabled) {
    registerFeedGeneratorRoutes(app, config, source);
    logger.info('フィードジェネレータを有効化しました', {
      hostname: config.feedGenerator.hostname,
    });
  }

  await registerStatic(app);

  app.addHook('onClose', (_instance, done) => {
    hub.close();
    done();
  });

  return app;
}
