/**
 * 公開 AppView からアカウントのプロフィール (表示名・アバター) を引く。
 *
 * メンバー管理の一覧と追加時の候補表示に使う。認証は不要な公開 API のみを叩く。
 * 同じ DID を何度も引かないよう、短い TTL のメモリキャッシュを挟む。
 */
import type { AppConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('actor-directory');

/** プロフィールの保持時間。表示名やアバターは滅多に変わらないため長めで良い。 */
const PROFILE_TTL_MS = 10 * 60 * 1000;
/** getProfiles の 1 回あたりの上限 (AppView の仕様)。 */
const PROFILE_BATCH = 25;
/** 候補表示の既定件数。 */
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

export interface ActorProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

export interface ActorDirectory {
  /** DID の一覧をプロフィールへ解決する。引けなかった DID は結果に入らない。 */
  profiles(dids: string[]): Promise<Map<string, ActorProfile>>;
  /** 入力中の文字列から候補を返す (app.bsky.actor.searchActorsTypeahead)。 */
  search(query: string, limit?: number): Promise<ActorProfile[]>;
}

interface CacheEntry {
  profile: ActorProfile;
  at: number;
}

function toProfile(raw: unknown): ActorProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.did !== 'string' || typeof value.handle !== 'string') return null;
  return {
    did: value.did,
    handle: value.handle,
    ...(typeof value.displayName === 'string' && value.displayName !== ''
      ? { displayName: value.displayName }
      : {}),
    ...(typeof value.avatar === 'string' && value.avatar !== '' ? { avatar: value.avatar } : {}),
  };
}

export function createActorDirectory(config: AppConfig): ActorDirectory {
  const cache = new Map<string, CacheEntry>();

  function remember(profile: ActorProfile): ActorProfile {
    cache.set(profile.did, { profile, at: Date.now() });
    return profile;
  }

  async function fetchProfiles(dids: string[]): Promise<ActorProfile[]> {
    const params = new URLSearchParams();
    for (const did of dids) params.append('actors', did);
    const res = await fetch(`${config.appview.url}/xrpc/app.bsky.actor.getProfiles?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { profiles?: unknown[] };
    const result: ActorProfile[] = [];
    for (const raw of data.profiles ?? []) {
      const profile = toProfile(raw);
      if (profile) result.push(profile);
    }
    return result;
  }

  return {
    async profiles(dids) {
      const result = new Map<string, ActorProfile>();
      const now = Date.now();
      const missing: string[] = [];
      for (const did of new Set(dids)) {
        const hit = cache.get(did);
        if (hit && now - hit.at < PROFILE_TTL_MS) {
          result.set(did, hit.profile);
        } else {
          missing.push(did);
        }
      }

      for (let i = 0; i < missing.length; i += PROFILE_BATCH) {
        const batch = missing.slice(i, i + PROFILE_BATCH);
        try {
          for (const profile of await fetchProfiles(batch)) {
            result.set(profile.did, remember(profile));
          }
        } catch (err) {
          // 引けなくても一覧は出す (表示名とアバターが欠けるだけ)。
          log.warn('プロフィールを取得できませんでした', { batch, err });
        }
      }
      return result;
    },

    async search(query, limit = DEFAULT_SEARCH_LIMIT) {
      const q = query.trim().replace(/^@/, '');
      if (q === '') return [];
      const params = new URLSearchParams({
        q,
        limit: String(Math.min(Math.max(1, Math.floor(limit)), MAX_SEARCH_LIMIT)),
      });
      try {
        const res = await fetch(
          `${config.appview.url}/xrpc/app.bsky.actor.searchActorsTypeahead?${params}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { actors?: unknown[] };
        const result: ActorProfile[] = [];
        for (const raw of data.actors ?? []) {
          const profile = toProfile(raw);
          if (profile) result.push(remember(profile));
        }
        return result;
      } catch (err) {
        log.warn('アカウント候補を取得できませんでした', { q, err });
        return [];
      }
    },
  };
}
