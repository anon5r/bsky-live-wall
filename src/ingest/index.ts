/**
 * ingest 層の公開エントリポイント。
 * server 層はここと `src/shared/contracts.ts` の型だけを参照する。
 */
import type { AppConfig } from '../shared/config.js';
import type { WallSource } from '../shared/contracts.js';
import { createTenantRegistry } from './tenant-registry.js';

export { WallManager, DEFAULT_WALL_ID } from './wall-manager.js';
export { createTenantRegistry, SingleTenantRegistry, MultiTenantRegistry } from './tenant-registry.js';

/**
 * 単一テナント運用向けの入口。段階 2-d (server 層のテナント対応) までの間、
 * 既存の呼び出し (`src/index.ts`) を壊さないためにシグネチャを変えていない。
 *
 * 内部では TenantRegistry を作り、その既定テナントを返す。`start()`/`stop()` は
 * 個々のテナントではなく registry 全体 (= IngestHub を含む) を起動・停止する。
 */
export function createWallSource(config: AppConfig): WallSource {
  const registry = createTenantRegistry(config);
  const runtime = registry.getDefault();
  return {
    // WallSource が要求するイベント購読・操作はすべて既定テナントの runtime に委譲する。
    on: (event, listener) => {
      runtime.on(event, listener);
    },
    off: (event, listener) => {
      runtime.off(event, listener);
    },
    // start/stop だけは registry 全体 (hub の接続を含む) を起動・停止する必要があるため、
    // runtime 単体ではなく registry のメソッドを呼ぶ。
    start: () => registry.start(),
    stop: () => registry.stop(),
    getWalls: () => runtime.getWalls(),
    getWall: (id) => runtime.getWall(id),
    getDefaultWall: () => runtime.getDefaultWall(),
    createWall: (input) => runtime.createWall(input),
    deleteWall: (id) => runtime.deleteWall(id),
    updateWall: (id, input) => runtime.updateWall(id, input),
    setPaused: (paused) => runtime.setPaused(paused),
    isPaused: () => runtime.isPaused(),
    hide: (uri) => runtime.hide(uri),
    unhide: (uri) => runtime.unhide(uri),
    getHidden: (limit) => runtime.getHidden(limit),
    blockActor: (actor) => runtime.blockActor(actor),
    unblockActor: (actor) => runtime.unblockActor(actor),
    getBlockedActors: () => runtime.getBlockedActors(),
    startBackfill: (input) => runtime.startBackfill(input),
    getBackfillStatus: () => runtime.getBackfillStatus(),
    getJetstreamHosts: () => runtime.getJetstreamHosts(),
    switchJetstreamHost: (host) => runtime.switchJetstreamHost(host),
    getModLists: () => runtime.getModLists(),
    subscribeModList: (uri) => runtime.subscribeModList(uri),
    unsubscribeModList: (uri) => runtime.unsubscribeModList(uri),
  };
}
