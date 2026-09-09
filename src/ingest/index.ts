/**
 * ingest 層の公開エントリポイント。
 * server 層はここと `src/shared/contracts.ts` の型だけを参照する。
 */
import type { AppConfig } from '../shared/config.js';
import type { WallSource } from '../shared/contracts.js';
import { WallManager } from './wall-manager.js';

export { WallManager, DEFAULT_WALL_ID } from './wall-manager.js';

export function createWallSource(config: AppConfig): WallSource {
  return new WallManager(config);
}
