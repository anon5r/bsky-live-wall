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
 * 配線済みのテナント。二重配線 (イベントが 2 回流れる) を防ぐ。
 * 起動時・テナント作成時・SSE 接続時のどこから呼ばれても 1 回だけ効くようにする。
 */
const wired = new WeakSet<TenantRuntime>();

/**
 * テナントの `WallSource` イベントを `HubRegistry` (SSE) へ中継する配線。
 * 何度呼んでも配線は 1 回だけ行われる。
 */
export function wireTenantBroadcast(tenant: TenantRuntime, hubs: HubRegistry): void {
  if (wired.has(tenant)) return;
  wired.add(tenant);
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

    // 起動順やテナントの作られ方に関わらず、接続の時点で中継が張られていることを
    // 保証する。配線済みなら何もしない。
    wireTenantBroadcast(tenant, hubs);

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
