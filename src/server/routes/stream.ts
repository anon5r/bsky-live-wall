/**
 * GET /api/stream: 会場モニター / 管理画面向けの SSE エンドポイント。
 *
 * ウォールごとに配信内容が違うため、接続は `?wall=<id>` で振り分ける。
 * 指定がなければ既定ウォールにつなぐ (従来の `/wall` と同じ挙動)。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { WallSource } from '../../shared/contracts.js';
import type { HelloPayload } from '../../shared/types.js';
import type { HubRegistry } from '../hub-registry.js';

export function registerStreamRoutes(
  app: FastifyInstance,
  config: AppConfig,
  source: WallSource,
  hubs: HubRegistry,
): void {
  // --- WallSource -> SseHub の中継 (起動時に 1 回だけ登録) ---
  // 接続のないウォールへは配信しないよう peek で確認する。
  source.on('post', (wallId, post) => hubs.peek(wallId)?.broadcast('post', post));
  source.on('history', (wallId, posts) => hubs.peek(wallId)?.broadcast('history', posts));
  source.on('remove', (wallId, payload) => hubs.peek(wallId)?.broadcast('remove', payload));
  source.on('state', (wallId, state) => hubs.peek(wallId)?.broadcast('state', state));
  // プロフィールの解決は全ウォール共通なので、すべての接続へ流す。
  source.on('profile', (payload) => {
    for (const wall of source.getWalls()) {
      hubs.peek(wall.id)?.broadcast('profile', payload);
    }
  });
  // 削除されたウォールにつながっている画面は切断する。
  source.on('walls', (walls) => {
    hubs.dropMissing(new Set(walls.map((w) => w.id)));
  });

  app.get<{ Querystring: { wall?: string } }>('/api/stream', async (request, reply) => {
    const wall = request.query.wall
      ? source.getWall(request.query.wall)
      : source.getDefaultWall();
    if (!wall) {
      return reply.code(404).send({ error: 'wall_not_found' });
    }

    // Fastify のライフサイクルを抜けて raw ストリームとして扱う。
    reply.hijack();

    const hub = hubs.get(wall.id);
    const id = hub.add(reply);

    const backlog = wall.getRecent(config.buffer.backlogSize).slice().reverse(); // 古い順
    const state = wall.getState();
    const hello: HelloPayload = {
      state,
      backlog,
      display: source.getWalls().find((w) => w.id === wall.id)?.display ?? config.display,
    };
    hub.sendTo(id, 'hello', hello);
  });
}
