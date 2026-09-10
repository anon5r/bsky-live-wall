/**
 * GET /api/stream: 会場モニター / 管理画面向けの SSE エンドポイント。
 *
 * ウォールごとに配信内容が違うため、接続は `?wall=<id>` で振り分ける。
 * 指定がなければ既定ウォールにつなぐ (従来の `/wall` と同じ挙動)。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { TenantRuntime } from '../../shared/ingest-contracts.js';
import type { HelloPayload } from '../../shared/types.js';
import type { HubRegistry } from '../hub-registry.js';
import { getTenant } from '../tenant-context.js';

/**
 * テナントの `WallSource` イベントを `HubRegistry` (SSE) へ中継する配線。
 * テナントごとに 1 回だけ呼ぶ (起動時に既存のテナント分、以後はテナント作成時に 1 回)。
 */
export function wireTenantBroadcast(tenant: TenantRuntime, hubs: HubRegistry): void {
  const { tenantId } = tenant;
  // 接続のないウォールへは配信しないよう peek で確認する。
  tenant.on('post', (wallId, post) => hubs.peek(tenantId, wallId)?.broadcast('post', post));
  tenant.on('history', (wallId, posts) => hubs.peek(tenantId, wallId)?.broadcast('history', posts));
  tenant.on('remove', (wallId, payload) => hubs.peek(tenantId, wallId)?.broadcast('remove', payload));
  tenant.on('state', (wallId, state) => hubs.peek(tenantId, wallId)?.broadcast('state', state));
  // プロフィールの解決はテナント内の全ウォール共通なので、すべての接続へ流す。
  tenant.on('profile', (payload) => {
    for (const wall of tenant.getWalls()) {
      hubs.peek(tenantId, wall.id)?.broadcast('profile', payload);
    }
  });
  // 削除されたウォールにつながっている画面は切断する。他テナントの Hub には触れない。
  tenant.on('walls', (walls) => {
    hubs.dropMissing(tenantId, new Set(walls.map((w) => w.id)));
  });
}

export function registerStreamRoutes(app: FastifyInstance, config: AppConfig, hubs: HubRegistry): void {
  app.get<{ Querystring: { wall?: string } }>('/api/stream', async (request, reply) => {
    const tenant = getTenant(request);
    const wall = request.query.wall ? tenant.getWall(request.query.wall) : tenant.getDefaultWall();
    if (!wall) {
      return reply.code(404).send({ error: 'wall_not_found' });
    }

    // Fastify のライフサイクルを抜けて raw ストリームとして扱う。
    reply.hijack();

    const hub = hubs.get(tenant.tenantId, wall.id);
    const id = hub.add(reply);

    const backlog = wall.getRecent(config.buffer.backlogSize).slice().reverse(); // 古い順
    const state = wall.getState();
    const hello: HelloPayload = {
      state,
      backlog,
      display: tenant.getWalls().find((w) => w.id === wall.id)?.display ?? config.display,
    };
    hub.sendTo(id, 'hello', hello);
  });
}
