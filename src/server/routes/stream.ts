/**
 * GET /api/stream: 会場モニター / 管理画面向けの SSE エンドポイント。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { WallSource } from '../../shared/contracts.js';
import type { HelloPayload } from '../../shared/types.js';
import type { SseHub } from '../sse-hub.js';

/**
 * `/api/stream` ルートを登録し、同時に WallSource のイベントを SseHub へ中継する
 * リスナをサーバー起動時に 1 回だけ張る。
 */
export function registerStreamRoutes(
  app: FastifyInstance,
  config: AppConfig,
  source: WallSource,
  hub: SseHub,
): void {
  // --- WallSource -> SseHub の中継 (起動時に 1 回だけ登録) ---
  source.on('post', (post) => hub.broadcast('post', post));
  source.on('profile', (payload) => hub.broadcast('profile', payload));
  source.on('remove', (payload) => hub.broadcast('remove', payload));
  source.on('state', (state) => hub.broadcast('state', state));

  app.get('/api/stream', async (request, reply) => {
    // Fastify のライフサイクルを抜けて raw ストリームとして扱う。
    reply.hijack();

    const id = hub.add(reply);

    const backlog = source.getRecent(config.buffer.backlogSize).slice().reverse(); // 古い順
    const hello: HelloPayload = {
      state: source.getState(),
      backlog,
      display: config.display,
    };
    hub.sendTo(id, 'hello', hello);
  });
}
