/**
 * モデレーション判定。純関数のみ。
 */
import type { BskyPostRecord, WallAuthor } from '../shared/types.js';

/** 除外対象とする自己申告ラベル。 */
const NSFW_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'sexual-figurative']);

export interface ModerationResult {
  ok: boolean;
  reason?: string;
}

/**
 * evaluate が実際に参照する項目だけを切り出した形。
 * `AppConfig['moderation']` (単一テナント) も `TenantSettings` から組み立てた
 * 値 (マルチテナント、NG 正規表現はコンパイル済みで渡す) も、どちらもこの形を
 * 満たすので特別な変換は要らない。
 */
export interface ModerationRules {
  ngWords: string[];
  ngPatterns: RegExp[];
  blockActors: string[];
  allowReplies: boolean;
  filterLabeled: boolean;
  allowedLangs: string[];
}

/**
 * 投稿を表示してよいか判定する。
 * NG ワード / NG 正規表現 / ブロック actor / リプライ設定 / ラベル / 言語 を評価する。
 */
export function evaluate(
  record: BskyPostRecord,
  author: { did: string; handle: string },
  config: ModerationRules
): ModerationResult {
  const did = author.did.toLowerCase();
  const handle = author.handle.toLowerCase();
  if (config.blockActors.includes(did) || config.blockActors.includes(handle)) {
    return { ok: false, reason: 'blocked-actor' };
  }

  if (!config.allowReplies && record.reply !== undefined) {
    return { ok: false, reason: 'reply' };
  }

  const text = (record.text ?? '').toLowerCase();
  for (const word of config.ngWords) {
    if (word && text.includes(word)) {
      return { ok: false, reason: 'ng-word' };
    }
  }
  for (const pattern of config.ngPatterns) {
    if (pattern.test(record.text ?? '')) {
      return { ok: false, reason: 'ng-pattern' };
    }
  }

  if (config.filterLabeled) {
    const values = record.labels?.values ?? [];
    for (const v of values) {
      if (NSFW_LABELS.has(v.val)) {
        return { ok: false, reason: 'labeled' };
      }
    }
  }

  if (config.allowedLangs.length > 0) {
    const langs = (record.langs ?? []).map((l) => l.toLowerCase());
    const hasAllowed = langs.some((l) => config.allowedLangs.includes(l));
    if (!hasAllowed) {
      return { ok: false, reason: 'lang' };
    }
  }

  return { ok: true };
}

/** WallAuthor 未解決時、DID/ハンドルのみで evaluate に渡すためのヘルパ型。 */
export type MinimalAuthor = Pick<WallAuthor, 'did' | 'handle'>;
