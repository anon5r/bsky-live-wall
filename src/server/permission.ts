/**
 * テナントに属する管理 API の権限判定。
 *
 * single モードには「メンバー」という概念が無く、認証さえ通れば従来どおり
 * 誰でも操作できる (`ADMIN_TOKEN` / loopback / OAuth 許可リストの既存の仕組みで
 * すでに絞られている)。multi モードでは、認証を通っていても「そのテナントの
 * メンバーか」を別に確認しないと、他人のテナントを操作できてしまう。
 *
 * `owner` は設定変更まで、`moderator` は運用操作のみ (`TenantRuntime.getMemberRole`
 * 参照)。呼び出し側は「この操作に最低限必要な role」を渡す。
 */
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../shared/config.js';
import type { TenantRuntime } from '../shared/ingest-contracts.js';
import type { TenantMember } from '../shared/tenancy.js';
import type { AdminSessionStore } from './admin-session.js';
import { getAuthedDid } from './admin-auth.js';

export type RequiredRole = TenantMember['role'];

export interface PermissionDenial {
  status: number;
  body: { error: string; message?: string };
}

/**
 * 許可されていれば `null`、拒否ならレスポンスに使う `{ status, body }` を返す。
 *
 * **multi + Bearer トークンの扱い**: Bearer 認証には DID が無く、
 * 「誰か」を特定できない。`ADMIN_TOKEN` は全テナント共通の秘密であり、
 * それだけでどれか 1 つのテナントの操作を許すとテナント分離が意味を失うため、
 * DID が取れない場合は一律で拒否する (403)。OAuth ログインのみが
 * テナント操作の入口になる。
 */
export function checkTenantPermission(
  config: AppConfig,
  sessions: AdminSessionStore,
  request: FastifyRequest,
  tenant: TenantRuntime,
  required: RequiredRole
): PermissionDenial | null {
  if (config.tenancy.mode !== 'multi') return null;

  const did = getAuthedDid(request, sessions);
  if (!did) {
    return {
      status: 403,
      body: { error: 'forbidden', message: 'テナントの操作には OAuth ログインが必要です' },
    };
  }

  const role = tenant.getMemberRole(did);
  if (!role) {
    return { status: 403, body: { error: 'forbidden', message: 'このテナントのメンバーではありません' } };
  }
  if (required === 'owner' && role !== 'owner') {
    return { status: 403, body: { error: 'forbidden', message: 'この操作はオーナーのみ実行できます' } };
  }
  return null;
}
