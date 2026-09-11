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
import type { FastifyInstance, FastifyReply } from 'fastify';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { TenantRegistry } from '../shared/ingest-contracts.js';
import type { TenancyMode } from '../shared/tenancy.js';
import type { ImageStore } from './image-store.js';

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

/**
 * URL 空間の設計 (マルチテナント化を見据えた形)。
 *
 *   /assets/...                     静的ファイル (ここに閉じ込める)
 *   /wall                           既定イベントの既定ウォール
 *   /wall/<wallId>                  既定イベントの個別ウォール
 *   /admin                          既定イベントの管理画面
 *   /e/<eventId>/wall               明示指定のイベント
 *   /e/<eventId>/wall/<wallId>
 *   /e/<eventId>/admin
 *
 * 静的ファイルを `/assets/` に閉じ込めるのが要点。ルート直下に置くと
 * `/wall/<wallId>` のような可変の経路と衝突し、ID の文字種で回避する
 * といった無理が必要になる。
 *
 * イベント ID の階層は、現状 1 イベントしかなくても経路に組み込んでおく。
 * 後から挿入すると既存の URL がすべて変わってしまうため。
 *
 * 存在しないテナントを 404 にする判定は `registry.get(id)` の有無で行う。
 * single モードでも registry には (`.env` 由来の) 1 件のテナントが必ずあるため、
 * 判定はモードに関わらず同じ形で書ける。
 */
export async function registerStatic(
  app: FastifyInstance,
  registry: TenantRegistry,
  mode: TenancyMode,
  uploads: { uploadDir?: string; images?: ImageStore } = {}
): Promise<void> {
  const publicDir = resolvePublicDir();

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/assets/',
    decorateReply: true,
  });

  // 会場モニターに出す任意画像 (QR など)。会場モニター自体が公開ページなので
  // ここも認証は掛けない。ファイル名は推測できない乱数にしてある。
  if (uploads.uploadDir) {
    const resolved = resolve(uploads.uploadDir);
    mkdirSync(resolved, { recursive: true });
    await app.register(fastifyStatic, {
      root: resolved,
      prefix: '/uploads/',
      decorateReply: false,
      index: false,
      // 差し替えたときに古い画像が残らないよう、URL のクエリで更新時刻を渡している。
      cacheControl: true,
      maxAge: 60_000,
    });
  }

  // 外部ストレージを非公開のまま使う構成では、アプリが同じ経路で中継する。
  // 会場モニターから見た URL の形はローカル保存のときと変わらない。
  if (uploads.images) {
    const images = uploads.images;
    app.get<{ Params: { key: string } }>('/uploads/:key', async (request, reply) => {
      const found = images.read ? await images.read(request.params.key) : null;
      if (!found) return reply.code(404).type('text/plain; charset=utf-8').send('not found');
      return reply
        .type(found.mime)
        .header('Cache-Control', 'public, max-age=60')
        .send(found.bytes);
    });
  }

  const sendWall = async (_request: unknown, reply: FastifyReply): Promise<unknown> =>
    reply.sendFile('wall/index.html');
  const sendAdmin = async (_request: unknown, reply: FastifyReply): Promise<unknown> =>
    reply.sendFile('admin/index.html');

  // 管理画面はどちらのモードでも同じ入口に置く。
  // multi では「ログイン後にテナントを選ぶ」画面として働く。
  app.get('/admin', sendAdmin);
  app.get('/admin/', sendAdmin);

  if (mode === 'single') {
    // 会場ローカル運用。URL は短いほうがよい (口頭や掲示で伝えるため)。
    app.get('/', async (_request, reply) => reply.redirect('/wall'));
    app.get('/wall', sendWall);
    app.get('/wall/', sendWall);
    app.get('/wall/:wallId', sendWall);
  } else {
    // 共有サービス。どのテナントかを省略できないため、
    // テナントなしの経路は管理画面へ誘導する。
    const toAdmin = async (_request: unknown, reply: FastifyReply) => reply.redirect('/admin');
    app.get('/', toAdmin);
    app.get('/wall', toAdmin);
    app.get('/wall/', toAdmin);
    app.get('/wall/:wallId', toAdmin);
  }

  // イベントを明示する経路。将来テナントが増えてもこの形のまま使える。
  // 存在しないイベントは 404 にする。画面を出してから API で失敗させるより、
  // URL の誤りをその場で分かるようにする。
  const requireEvent = async (
    request: { params: { eventId?: string } },
    reply: FastifyReply
  ): Promise<boolean> => {
    if (request.params.eventId !== undefined && registry.get(request.params.eventId) !== undefined) {
      return true;
    }
    await reply.code(404).type('text/plain; charset=utf-8').send('event not found');
    return false;
  };

  app.get<{ Params: { eventId: string } }>('/e/:eventId/wall', async (request, reply) => {
    if (await requireEvent(request, reply)) return sendWall(request, reply);
    return reply;
  });
  app.get<{ Params: { eventId: string } }>('/e/:eventId/wall/', async (request, reply) => {
    if (await requireEvent(request, reply)) return sendWall(request, reply);
    return reply;
  });
  app.get<{ Params: { eventId: string; wallId: string } }>(
    '/e/:eventId/wall/:wallId',
    async (request, reply) => {
      if (await requireEvent(request, reply)) return sendWall(request, reply);
      return reply;
    }
  );
  app.get<{ Params: { eventId: string } }>('/e/:eventId/admin', async (request, reply) => {
    if (await requireEvent(request, reply)) return sendAdmin(request, reply);
    return reply;
  });
  app.get<{ Params: { eventId: string } }>('/e/:eventId/admin/', async (request, reply) => {
    if (await requireEvent(request, reply)) return sendAdmin(request, reply);
    return reply;
  });

  const defaultTenantId = registry.list()[0]?.tenantId ?? '<tenant>';
  logger.info('URL を割り当てました', {
    mode,
    wall: mode === 'single' ? '/wall' : `/e/<tenant>/wall`,
    wallExplicit: `/e/${defaultTenantId}/wall`,
    admin: '/admin',
    assets: '/assets/',
  });
}
