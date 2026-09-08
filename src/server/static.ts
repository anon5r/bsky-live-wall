/**
 * `public/` 配下の静的配信。
 *
 * `src` を tsx で直接実行する場合 (`src/server/static.ts`) と、ビルド後に
 * `dist` から実行する場合 (`dist/server/static.js`) の両方で、実行位置に関わらず
 * 常に `<repo>/public` を指すようにパスを解決する。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('static');

/**
 * `<repo>/public` を解決する。
 * `src/server/static.ts` (tsx 実行時) と `dist/server/static.js` (ビルド後実行時) の
 * どちらも `<something>/server/static.*` という同じ深さにあるため、
 * まずは 2 階層上 (`../../public`) を試す。見つからない場合は念のため
 * 祖先ディレクトリを遡って `public/` を探索する。
 */
export function resolvePublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const primary = path.resolve(here, '../../public');
  if (existsSync(primary)) return primary;

  // フォールバック: 祖先を遡って public/ ディレクトリを探す。
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'public');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  logger.warn('public ディレクトリが見つかりませんでした。既定値を使用します', { primary });
  return primary;
}

export async function registerStatic(app: FastifyInstance): Promise<void> {
  const publicDir = resolvePublicDir();

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    decorateReply: true,
  });

  app.get('/', async (_request, reply) => {
    return reply.redirect('/wall');
  });

  app.get('/wall', async (_request, reply) => {
    return reply.sendFile('wall/index.html');
  });

  app.get('/wall/', async (_request, reply) => {
    return reply.sendFile('wall/index.html');
  });

  app.get('/admin', async (_request, reply) => {
    return reply.sendFile('admin/index.html');
  });

  app.get('/admin/', async (_request, reply) => {
    return reply.sendFile('admin/index.html');
  });
}
