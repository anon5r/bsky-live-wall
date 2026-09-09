/**
 * テナント設定の既定値。
 *
 * `createTenant` で `settings` が省略/部分指定された場合にここで埋める。
 * `.env` ベースの単一テナント運用 (src/shared/config.ts) の既定値と揃えてある。
 */
import type { TenantSettings } from '../shared/tenancy.js';

export function defaultTenantSettings(): TenantSettings {
  return {
    title: 'Bluesky Live Wall',
    subtitle: '',
    moderationMode: 'open',
    keywordRequireApproval: true,
    ngWords: [],
    ngPatterns: [],
    blockActors: [],
    allowReplies: true,
    filterLabeled: true,
    allowedLangs: [],
    startupBackfillMinutes: 120,
  };
}
