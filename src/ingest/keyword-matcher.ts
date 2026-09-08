/**
 * 本文中の任意のキーワードへの一致を判定する。
 *
 * ハッシュタグと違い、キーワード一致は投稿者がイベントを意識していなくても
 * 拾ってしまう。誤って広く拾わないよう、比較は正規化した部分一致に限定し、
 * 短すぎる語は設定側で弾く。
 */
import { normalizeKeyword } from '../shared/config.js';
import type { BskyPostRecord, WatchTerm } from '../shared/types.js';

/**
 * 監視キーワードのうち、本文に含まれるものの「設定された表記」を返す。
 * 日本語には単語境界がないため、判定は部分一致で行う。
 */
export function matchKeywords(record: BskyPostRecord, terms: WatchTerm[]): string[] {
  const keywords = terms.filter((t) => t.type === 'keyword');
  if (keywords.length === 0) return [];

  const text = normalizeKeyword(record.text ?? '');
  if (text === '') return [];

  const matched: string[] = [];
  for (const term of keywords) {
    if (text.includes(term.normalized)) matched.push(term.value);
  }
  return matched;
}
