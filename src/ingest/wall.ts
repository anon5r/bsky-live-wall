/**
 * ウォール 1 つ分の状態。
 *
 * 監視語・投稿バッファ・承認待ちはウォールごとに独立する。
 * モデレーション (ブロック / 非表示 / リスト購読 / 一時停止) は
 * WallManager が全ウォール共通で持つ。
 */
import {
  RESERVED_SLUGS,
  defaultWallScreen,
  normalizeKeyword,
  normalizeSlug,
  normalizeTag,
  type AppConfig,
} from '../shared/config.js';
import type {
  ApprovalSetting,
  DisplayConfig,
  ExcludePolicy,
  ExcludeTerm,
  ModerationMode,
  BskyPostRecord,
  WallModerationMode,
  WallPost,
  WallScreen,
  WallSummary,
  WatchTerm,
} from '../shared/types.js';
import type { PersistedScreenImage } from '../shared/tenancy.js';
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
    bufferSize: number,
    /** 承認モード。'inherit' ならテナント設定に従う。 */
    public moderationMode: WallModerationMode = 'inherit',
    /** キーワードのみ一致の扱い。'inherit' ならテナント設定に従う。 */
    public keywordRequireApproval: ApprovalSetting = 'inherit',
    /** 除外キーワード。本文に含まれていたらこのウォールでは拾わない。 */
    public excludeTerms: ExcludeTerm[] = [],
    /** 除外キーワードに一致した投稿の扱い。 */
    public excludePolicy: ExcludePolicy = 'reject',
    /** 会場モニターの画面モードと文言。 */
    public screen: WallScreen = defaultWallScreen(),
    /** 任意画像 (QR など)。実体はファイル、ここではメタだけ持つ。 */
    public screenImage: PersistedScreenImage | null = null,
    /**
     * 画像を直接配る URL の基点。
     * 空ならアプリ自身が `/uploads/` で配る (ローカル保存、または非公開バケットの中継)。
     */
    public imageBaseUrl: string = ''
  ) {
    this.store = new PostStore({ size: bufferSize, pendingSize: bufferSize });
  }

  get hashtags(): string[] {
    return this.terms.filter((t) => t.type === 'hashtag').map((t) => t.value);
  }

  get normalizedHashtags(): string[] {
    return this.terms.filter((t) => t.type === 'hashtag').map((t) => t.normalized);
  }

  /**
   * 一致結果に対応する監視語を返す。
   * ハッシュタグの一致は投稿側の表記で返ってくるため、正規化して突き合わせる。
   */
  matchedTerms(tags: string[], keywords: string[]): WatchTerm[] {
    const normalizedTags = new Set(tags.map((t) => normalizeTag(t)));
    const keywordValues = new Set(keywords);
    return this.terms.filter((term) =>
      term.type === 'hashtag' ? normalizedTags.has(term.normalized) : keywordValues.has(term.value)
    );
  }

  /**
   * 本文に含まれる除外キーワードの「設定された表記」を返す。
   * 監視キーワードと同じく、正規化した部分一致で判定する。
   */
  matchExcludes(record: BskyPostRecord): string[] {
    if (this.excludeTerms.length === 0) return [];
    const text = normalizeKeyword(record.text ?? '');
    if (text === '') return [];
    return this.excludeTerms.filter((t) => text.includes(t.normalized)).map((t) => t.value);
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
      moderationMode: this.moderationMode,
      keywordRequireApproval: this.keywordRequireApproval,
      excludeTerms: this.excludeTerms,
      excludePolicy: this.excludePolicy,
      screen: this.screen,
      screenImageUrl: this.screenImageUrl(),
    };
  }

  /**
   * 任意画像の配信 URL。更新時刻をクエリに付けて、差し替えたときに
   * 会場モニター側の古いキャッシュが残らないようにする。
   */
  screenImageUrl(): string | null {
    if (!this.screenImage) return null;
    const name = encodeURIComponent(this.screenImage.file);
    const base = this.imageBaseUrl || '/uploads';
    return `${base}/${name}?v=${this.screenImage.updatedAt}`;
  }
}

/** 承認要否の判定に必要な設定。継承はすべて解決済みの値を渡す。 */
export interface ApprovalContext {
  /** このウォールに適用される承認モード (継承解決済み) */
  moderationMode: ModerationMode;
  /** キーワードのみ一致を承認待ちにするか (継承解決済み) */
  keywordRequireApproval: boolean;
}

/**
 * 投稿を承認待ちにするかを決める純関数。
 *
 * 優先順位:
 * 1. ウォールの承認モードが 'approve' なら、語の設定によらず必ず承認待ち。
 *    会場のポリシーを語ごとの設定で穴あきにしないため。
 * 2. 一致した語に 'always' があれば承認待ち。
 * 3. ハッシュタグが付いていない (キーワードのみ一致) 投稿は、投稿者がイベントを
 *    意識していない可能性があるため既定で承認待ち。ただし一致したキーワードが
 *    すべて 'never' なら、意図して設定した語とみなして即時表示する。
 * 4. それ以外は即時表示。
 */
export function needsApproval(
  matched: WatchTerm[],
  hasHashtagHit: boolean,
  context: ApprovalContext
): boolean {
  if (context.moderationMode === 'approve') return true;
  if (matched.some((t) => t.requireApproval === 'always')) return true;
  if (hasHashtagHit) return false;

  const keywords = matched.filter((t) => t.type === 'keyword');
  if (keywords.length === 0) return false;
  if (keywords.every((t) => t.requireApproval === 'never')) return false;
  return context.keywordRequireApproval;
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
    showClock: config.display.showClock,
    showSeconds: config.display.showSeconds,
    showTerms: config.display.showTerms,
    showKeywords: config.display.showKeywords,
  };
}
