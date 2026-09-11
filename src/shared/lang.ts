/**
 * 取り込む投稿の言語フィルタ。
 *
 * 投稿の `langs` は BCP-47 (`ja` / `en-US` / `zh-Hant` など) で入る。
 * 絞り込みは基底のサブタグ (最初の `-` まで) で行う。`en` を選んだときに
 * `en-US` の投稿が落ちるのは利用者の意図と食い違うため。
 */

/** 言語タグを比較用に整える。`en-US` → `en`。 */
export function normalizeLang(tag: string): string {
  return (tag || '').trim().toLowerCase().split('-')[0] ?? '';
}

/** 重複と空を落として整えた言語タグの一覧。 */
export function normalizeLangs(tags: readonly string[] | undefined | null): string[] {
  const result: string[] = [];
  for (const tag of tags ?? []) {
    if (typeof tag !== 'string') continue;
    const normalized = normalizeLang(tag);
    if (normalized === '' || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

/**
 * 投稿を取り込んでよいか。
 * `allowed` が空なら全言語を通す (絞り込みなし)。
 * 言語が付いていない投稿は、絞り込みが有効なときは通さない
 * (「日本語だけ」と指定したのに言語不明の投稿が出るのを避けるため)。
 */
export function matchesLang(
  postLangs: readonly string[] | undefined | null,
  allowed: readonly string[]
): boolean {
  if (allowed.length === 0) return true;
  const wanted = normalizeLangs(allowed);
  if (wanted.length === 0) return true;
  return normalizeLangs(postLangs).some((lang) => wanted.includes(lang));
}
