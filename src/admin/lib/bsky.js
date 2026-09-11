/**
 * Bluesky の公開 AppView への問い合わせ (管理画面から直接叩く)。
 *
 * 認証も特別な権限も要らない公開 API のみを使うため、サーバーを経由しない。
 * 宛先はサーバーから受け取る (独自の AppView を指している構成があるため)。
 */

/** プロフィールの保持時間。表示名やアバターは滅多に変わらない。 */
const PROFILE_TTL_MS = 10 * 60 * 1000;
/** getProfiles の 1 回あたりの上限 (AppView の仕様)。 */
const PROFILE_BATCH = 25;
const DEFAULT_APPVIEW = 'https://public.api.bsky.app';
const SEARCH_LIMIT = 8;

let appviewUrl = DEFAULT_APPVIEW;
const cache = new Map();

/** 状態の取得時にサーバーから受け取った AppView を覚える。 */
export function setAppviewUrl(url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    appviewUrl = url.replace(/\/+$/, '');
  }
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.did !== 'string' || typeof raw.handle !== 'string') return null;
  return {
    did: raw.did,
    handle: raw.handle,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
    avatar: typeof raw.avatar === 'string' ? raw.avatar : '',
  };
}

function remember(profile) {
  cache.set(profile.did, { profile, at: Date.now() });
  return profile;
}

/**
 * DID の一覧をプロフィールへ解決する。
 * 引けなかった DID は結果に入らない (呼び出し側は保存済みのハンドルで表示する)。
 */
export async function fetchProfiles(dids) {
  const result = new Map();
  const now = Date.now();
  const missing = [];
  for (const did of new Set(dids || [])) {
    if (typeof did !== 'string' || did === '') continue;
    const hit = cache.get(did);
    if (hit && now - hit.at < PROFILE_TTL_MS) {
      result.set(did, hit.profile);
    } else {
      missing.push(did);
    }
  }

  for (let i = 0; i < missing.length; i += PROFILE_BATCH) {
    const batch = missing.slice(i, i + PROFILE_BATCH);
    const params = new URLSearchParams();
    for (const did of batch) params.append('actors', did);
    try {
      const res = await fetch(appviewUrl + '/xrpc/app.bsky.actor.getProfiles?' + params);
      if (!res.ok) continue;
      const data = await res.json();
      for (const raw of data.profiles || []) {
        const profile = normalize(raw);
        if (profile) result.set(profile.did, remember(profile));
      }
    } catch {
      // 引けなくても一覧は出す (表示名とアバターが欠けるだけ)。
    }
  }
  return result;
}

/** 入力中の文字列からアカウント候補を引く。失敗しても入力を妨げない。 */
export async function searchActors(query) {
  const q = (query || '').trim().replace(/^@/, '');
  if (q === '') return [];
  const params = new URLSearchParams({ q, limit: String(SEARCH_LIMIT) });
  try {
    const res = await fetch(appviewUrl + '/xrpc/app.bsky.actor.searchActorsTypeahead?' + params);
    if (!res.ok) return [];
    const data = await res.json();
    const actors = [];
    for (const raw of data.actors || []) {
      const profile = normalize(raw);
      if (profile) actors.push(remember(profile));
    }
    return actors;
  } catch {
    return [];
  }
}

/**
 * did / handle を持つ一覧にプロフィールを添える。
 * 表示名とアバターが増えるだけで、引けなければ元の要素をそのまま返す。
 */
export async function withProfiles(items) {
  const list = items || [];
  if (list.length === 0) return [];
  const profiles = await fetchProfiles(list.map((item) => item.did));
  return list.map((item) => {
    const profile = profiles.get(item.did);
    if (!profile) return item;
    return {
      ...item,
      handle: profile.handle || item.handle,
      displayName: profile.displayName,
      avatar: profile.avatar,
    };
  });
}
