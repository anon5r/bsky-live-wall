/**
 * 投稿レコードから対象ハッシュタグへの一致を判定する純関数群。
 */
import type { BskyPostRecord } from '../shared/types.js';
import { normalizeTag } from '../shared/config.js';

// ASCII '#' と全角 '＃' の両方を認識する。
// タグ本体は空白・改行・句読点・記号で終端し、日本語文字 (ひらがな/カタカナ/漢字/全角英数) は含める。
const HASHTAG_RE =
  /[#＃]([\p{L}\p{N}\p{M}_ー々〆〤]+)/gu;

/**
 * record.text からプレーンテキストの #タグ を抽出する。
 */
function extractTextHashtags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HASHTAG_RE)) {
    const tag = m[1];
    if (tag) out.push(tag);
  }
  return out;
}

/**
 * 投稿レコードから、監視対象タグに一致した「投稿側の元表記」を重複排除して返す。
 * 判定元: facets の #tag features / record.tags / text 中の #タグ 表記。
 */
export function matchHashtags(record: BskyPostRecord, normalizedTargets: string[]): string[] {
  if (normalizedTargets.length === 0) return [];
  const targetSet = new Set(normalizedTargets);
  const seen = new Set<string>();
  const matched: string[] = [];

  const consider = (raw: string | undefined): void => {
    if (!raw) return;
    const normalized = normalizeTag(raw);
    if (!normalized || !targetSet.has(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    matched.push(raw);
  };

  for (const facet of record.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag) {
        consider(feature.tag);
      }
    }
  }

  for (const tag of record.tags ?? []) {
    consider(tag);
  }

  if (record.text) {
    for (const tag of extractTextHashtags(record.text)) {
      consider(tag);
    }
  }

  return matched;
}
