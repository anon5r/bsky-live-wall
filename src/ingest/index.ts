/**
 * ingest 層の公開エントリポイント。
 * server 層はここと `src/shared/contracts.ts` / `src/shared/ingest-contracts.ts` の
 * 型だけを参照する。
 *
 * 段階 2-d で server 層 (`createServer`) が `WallSource` 単体ではなく
 * `TenantRegistry` を受け取るようになったため、以前ここにあった
 * `createWallSource` (既定テナントだけを `WallSource` として見せる互換シム) は
 * 不要になり削除した。`src/index.ts` は `createTenantRegistry` を直接使う。
 */
export { WallManager, DEFAULT_WALL_ID } from './wall-manager.js';
export { createTenantRegistry, SingleTenantRegistry, MultiTenantRegistry } from './tenant-registry.js';
