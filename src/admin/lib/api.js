/**
 * fetch のラッパー。
 *
 * - 認証は HttpOnly Cookie によるセッション。CSRF 対策としてカスタムヘッダを
 *   常に付ける (クロスオリジンからはプリフライトなしに付与できないため)。
 * - 401 を受けたときの後始末は呼び出し側 (store) に一任する
 *   (onUnauthorized コールバックを登録して呼び出す)。
 */

let onUnauthorized = () => {};

/** 401 応答を受け取ったときの処理を登録する。store から一度だけ呼ばれる。 */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/**
 * テナント接頭辞 ('' または '/e/<tenantId>')。
 *
 * single モードでは常に '' (ルート直下の /api/... をそのまま使う)。
 * multi モードでは現在開いているテナントに応じて '/e/<tenantId>' を設定する。
 * テナントに属さない API (auth/me, admin/tenants, admin/system/* など) は
 * この接頭辞を使わず、常にルート直下を叩くこと。
 */
let tenantPrefix = '';

/** 現在のテナント接頭辞を設定する。store がルート解決のたびに呼ぶ。 */
export function setTenantPrefix(prefix) {
  tenantPrefix = prefix || '';
}

/** テナントに属する API のパスへ、現在の接頭辞を付与する。 */
export function tenantPath(path) {
  return tenantPrefix + path;
}

/**
 * 認証ヘッダ付きで fetch する。
 * ネットワークエラーは例外として呼び出し側へ伝播する。
 */
export function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  headers['X-Requested-With'] = 'bsky-live-wall';
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    // セッション Cookie を必ず送る。
    credentials: 'same-origin',
  });
}

/**
 * 管理 API (POST 系) を呼び出す共通ヘルパー。
 * 401 は onUnauthorized を呼んでから例外を投げる。
 */
export async function callAdminApi(path, bodyObj) {
  const options = { method: 'POST' };
  if (bodyObj !== undefined) {
    options.body = JSON.stringify(bodyObj);
  }
  const res = await apiFetch(path, options);
  if (res.status === 401) {
    onUnauthorized();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    throw new Error('request failed: ' + res.status);
  }
  return res;
}
