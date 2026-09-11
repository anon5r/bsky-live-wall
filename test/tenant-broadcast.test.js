import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiTenantRegistry } from '../dist/ingest/tenant-registry.js';
import { SqliteTenantStore } from '../dist/store/sqlite-store.js';
import { wireTenantBroadcast } from '../dist/server/routes/stream.js';
import { HubRegistry } from '../dist/server/hub-registry.js';
import { loadConfig } from '../dist/shared/config.js';

function stubHub() {
  return {
    on() {},
    off() {},
    async start() {},
    async stop() {},
    getStatus: () => ({ connected: false, host: null, reconnects: 0, backfilling: false }),
    getHosts: () => [],
    switchHost: () => true,
    startBackfill: () => ({ ok: true }),
    getBackfillStatus: () => ({ running: false, startedAt: 0, finishedAt: 0, minutes: 0 }),
    resolveAuthor: (did) => ({ did, handle: 'someone.bsky.social' }),
  };
}

function multiConfig() {
  const base = loadConfig();
  const dataFile = join(mkdtempSync(join(tmpdir(), 'wall-broadcast-')), 'wall.db');
  const store = new SqliteTenantStore(dataFile);
  store.createTenant({ id: 'anon', name: 'テスト', ownerDid: 'did:plc:o', ownerHandle: 'o.bsky.social' });
  store.close();
  return { ...base, tenancy: { ...base.tenancy, mode: 'multi', dataFile } };
}

test('multi モードのテナントは registry.start() で初めて組み立てられる', async () => {
  const registry = new MultiTenantRegistry(multiConfig(), stubHub());

  // createServer が registry.start() より先に呼ばれると、この時点の list() を見て
  // 配線するため 1 件も中継されない (会場モニターに投稿が届かない) 。
  assert.equal(registry.list().length, 0);

  await registry.start();
  assert.equal(registry.list().length, 1);

  await registry.stop();
});

test('中継の配線は何度呼んでも 1 回だけ行われる', async () => {
  const registry = new MultiTenantRegistry(multiConfig(), stubHub());
  await registry.start();
  const tenant = registry.get('anon');
  const hubs = new HubRegistry();

  wireTenantBroadcast(tenant, hubs);
  const after1 = tenant.listenerCount('post');
  wireTenantBroadcast(tenant, hubs);
  const after2 = tenant.listenerCount('post');

  assert.equal(after1, 1);
  assert.equal(after2, 1);

  await registry.stop();
});
