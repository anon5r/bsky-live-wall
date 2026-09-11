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
 * システム管理者 (`.env` の `SYSTEM_ADMINS`) の DID 集合。
 *
 * テナントの owner は「テナントのメンバー表」(DB) にしか存在しないため、
 * テナントが 1 件も無い初期状態では誰も管理操作を行えない。システム管理者は
 * それとは別に `.env` で持つことで、DB が空でも壊れても締め出されないようにする。
 * ハンドルは起動時に DID へ解決してから (`resolveSystemAdmins`) ここへ渡す
 * (`setSystemAdminDids`)。以降の判定は同期的な Set 参照で完結する。
 */
let systemAdminDids: ReadonlySet<string> = new Set();

/** 起動時に一度だけ呼ぶ。`SYSTEM_ADMINS` を DID へ解決した結果を渡す。 */
export function setSystemAdminDids(dids: ReadonlySet<string>): void {
  systemAdminDids = dids;
}

/** 現在登録されているシステム管理者の DID 集合 (テスト・診断用)。 */
export function getSystemAdminDids(): ReadonlySet<string> {
  return systemAdminDids;
}

/** この DID がシステム管理者かどうか。システム管理者は全テナントに対して owner 相当。 */
export function isSystemAdmin(did: string | undefined): boolean {
  return did !== undefined && systemAdminDids.has(did);
}

/**
 * 許可されていれば `null`、拒否ならレスポンスに使う `{ status, body }` を返す。
 *
 * **システム管理者の扱い**: `isSystemAdmin(did)` が true なら、対象テナントの
 * メンバーであるかに関わらず常に許可する (owner 相当)。
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
  if (isSystemAdmin(did)) return null;

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
