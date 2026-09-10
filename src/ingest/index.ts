/**
 * ingest 層の公開エントリポイント。
 * server 層はここと `src/shared/contracts.ts` の型だけを参照する。
 */
import type { AppConfig } from '../shared/config.js';
import type { WallSource } from '../shared/contracts.js';
import { createIngestHub } from './ingest-hub.js';
import { WallManager } from './wall-manager.js';

export { WallManager, DEFAULT_WALL_ID } from './wall-manager.js';

export function createWallSource(config: AppConfig): WallSource {
  // IngestHub (Jetstream 接続・バックフィル・プロフィール解決) はサーバー全体で
  // 1 個だけ持つ。WallManager はそれを受け取って自分のテナント分だけ振り分ける。
  const hub = createIngestHub(config);
  return new WallManager(config, hub);
}
