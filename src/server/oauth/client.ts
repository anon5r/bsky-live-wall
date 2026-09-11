/**
 * AT Protocol OAuth のクライアント構築と、管理を許可するアカウントの解決。
 *
 * OAuth が担うのは「本人確認 (認証)」だけで、「管理してよいか (認可)」は
 * `ADMIN_ACTORS` の許可リストで決める。招待制はこのリストが実体になる。
 *
 * 要求するスコープは `atproto` のみ。本システムは利用者に代わって
 * 投稿したりデータを読んだりしないため、これ以上の権限は求めない。
 */
import { NodeOAuthClient } from '@atproto/oauth-client-node';
import type { OAuthClientMetadataInput } from '@atproto/oauth-client-node';
import type { AppConfig } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { createSessionStore, createStateStore } from './stores.js';

const log = createLogger('oauth');

export const CALLBACK_PATH = '/api/auth/callback';
export const CLIENT_METADATA_PATH = '/client-metadata.json';
const SCOPE = 'atproto';

/** localhost 開発では、メタデータを公開せずに特殊な client_id を使える。 */
function isLocalhost(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
}

export function buildClientMetadata(config: AppConfig): OAuthClientMetadataInput {
  const base = config.oauth.publicUrl;
  const redirectUri = `${base}${CALLBACK_PATH}`;

  // localhost 開発向けの client_id。メタデータ文書の公開が不要になる。
  const clientId = isLocalhost(base)
    ? `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`
    : `${base}${CLIENT_METADATA_PATH}`;

  return {
    client_id: clientId,
    client_name: 'Bluesky Live Wall',
    client_uri: base,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SCOPE,
    application_type: 'web',
    // 本システムは本人確認にしか OAuth を使わないため公開クライアントで足りる。
    // 秘密鍵の生成・保管・ローテーションを持ち込まない判断。
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  };
}

export function createOAuthClient(config: AppConfig): NodeOAuthClient {
  return new NodeOAuthClient({
    clientMetadata: buildClientMetadata(config),
    stateStore: createStateStore(),
    sessionStore: createSessionStore(),
    allowHttp: config.oauth.allowHttp,
  });
}

export interface AllowedActor {
  did: string;
  handle: string;
}

/**
 * アクター (ハンドルまたは DID) の一覧を DID へ解決する。
 * ハンドルは変更され得るため、認可の判定には必ず DID を使う。
 * `ADMIN_ACTORS` (許可リスト) と `SYSTEM_ADMINS` (システム管理者) の両方が
 * 同じ形式・同じ解決方法を使うため、共通処理として切り出してある。
 */
export async function resolveActors(
  config: AppConfig,
  actors: string[]
): Promise<Map<string, AllowedActor>> {
  const result = new Map<string, AllowedActor>();
  const handles = actors.filter((a) => !a.startsWith('did:'));
  const dids = actors.filter((a) => a.startsWith('did:'));

  for (const did of dids) {
    result.set(did, { did, handle: did });
  }

  // 公開 AppView は認証なしでプロフィールを引ける。25 件ずつ問い合わせる。
  for (let i = 0; i < handles.length; i += 25) {
    const batch = handles.slice(i, i + 25);
    const params = new URLSearchParams();
    for (const handle of batch) params.append('actors', handle);
    try {
      const res = await fetch(`${config.appview.url}/xrpc/app.bsky.actor.getProfiles?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { profiles?: { did: string; handle: string }[] };
      for (const profile of data.profiles ?? []) {
        result.set(profile.did, { did: profile.did, handle: profile.handle });
      }
    } catch (err) {
      // 解決できなかったハンドルは許可されない。起動は止めない。
      log.error('許可アカウントのハンドル解決に失敗しました', { batch, err });
    }
  }

  const unresolved = handles.filter(
    (h) => ![...result.values()].some((a) => a.handle.toLowerCase() === h)
  );
  if (unresolved.length > 0) {
    log.warn('解決できなかった許可アカウントがあります (このアカウントはログインできません)', {
      unresolved,
    });
  }

  return result;
}

/** `ADMIN_ACTORS` (管理を許可するアカウント) を DID へ解決する。 */
export async function resolveAllowedActors(config: AppConfig): Promise<Map<string, AllowedActor>> {
  return resolveActors(config, config.admin.allowedActors);
}

/** `SYSTEM_ADMINS` を DID へ解決する。 */
export async function resolveSystemAdmins(config: AppConfig): Promise<Map<string, AllowedActor>> {
  return resolveActors(config, config.admin.systemAdmins);
}

/**
 * 単一のアクター (ハンドルまたは DID) を DID へ解決する。
 * メンバー追加・テナント作成時のオーナー指定など、その場で 1 件だけ解決したいときに使う。
 * 解決できなければ `undefined`。
 */
export async function resolveActor(config: AppConfig, actor: string): Promise<AllowedActor | undefined> {
  const trimmed = actor.trim().replace(/^@/, '');
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('did:')) return { did: trimmed, handle: trimmed };
  const resolved = await resolveActors(config, [trimmed]);
  for (const a of resolved.values()) {
    if (a.handle.toLowerCase() === trimmed.toLowerCase()) return a;
  }
  return undefined;
}
