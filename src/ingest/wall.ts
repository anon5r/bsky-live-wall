/**
 * ウォール 1 つ分の状態。
 *
 * 監視語・投稿バッファ・承認待ちはウォールごとに独立する。
 * モデレーション (ブロック / 非表示 / リスト購読 / 一時停止) は
 * WallManager が全ウォール共通で持つ。
 */
import { RESERVED_SLUGS, normalizeSlug, type AppConfig } from '../shared/config.js';
import type { DisplayConfig, WallPost, WallSummary, WatchTerm } from '../shared/types.js';
import { PostStore } from './post-store.js';

export class Wall {
  readonly store: PostStore;
  /** バックフィル中に拾った投稿の一時置き場 (確定するまで表示しない)。 */
  backfillBuffer = new Map<string, WallPost>();

  constructor(
    readonly id: string,
    public name: string,
    public terms: WatchTerm[],
    public display: DisplayConfig,
    /** .env から作られた既定ウォール。削除できない。 */
    readonly isDefault: boolean,
    bufferSize: number
  ) {
    this.store = new PostStore({ size: bufferSize, pendingSize: bufferSize });
  }

  get hashtags(): string[] {
    return this.terms.filter((t) => t.type === 'hashtag').map((t) => t.value);
  }

  get normalizedHashtags(): string[] {
    return this.terms.filter((t) => t.type === 'hashtag').map((t) => t.normalized);
  }

  toSummary(): WallSummary {
    return {
      id: this.id,
      name: this.name,
      terms: this.terms,
      display: this.display,
      postCount: this.store.getRecent(Number.MAX_SAFE_INTEGER).length,
      pendingCount: this.store.getPending(Number.MAX_SAFE_INTEGER).length,
      isDefault: this.isDefault,
    };
  }
}

/**
 * ウォール ID として使える形に整える。URL に載るため文字種を絞る。
 * 経路として予約されている語は使えない (`/wall/admin` のような曖昧な URL を防ぐ)。
 */
export function normalizeWallId(input: string): string {
  const slug = normalizeSlug(input);
  return RESERVED_SLUGS.has(slug) ? '' : slug;
}

/** 既定ウォールの表示設定を config から作る。 */
export function displayFromConfig(config: AppConfig): DisplayConfig {
  return {
    maxCards: config.display.maxCards,
    columns: config.display.columns,
    cardTtlSec: config.display.cardTtlSec,
    showImages: config.display.showImages,
  };
}
