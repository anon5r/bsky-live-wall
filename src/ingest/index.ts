/**
 * ingest 層のエントリポイント。server 層はここだけを import する。
 */
import type { AppConfig } from '../shared/config.js';
import type { WallSource } from '../shared/contracts.js';
import { WallPipeline } from './pipeline.js';

export { WallPipeline };

/** 設定から WallSource の実体を生成する。 */
export function createWallSource(config: AppConfig): WallSource {
  return new WallPipeline(config);
}
