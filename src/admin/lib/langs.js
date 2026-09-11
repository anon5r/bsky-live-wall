/**
 * 言語フィルタで選べる言語。
 *
 * Bluesky が投稿の言語として扱うのと同じ ISO 639-1 の一覧 (184 件)。
 * 表示名は `Intl.DisplayNames` で作るため、名前の対訳表は持たない。
 * 判定と保存は基底のサブタグで行う (`en` を選べば `en-US` の投稿も拾う)。
 */

/** ISO 639-1 の言語コード。 */
export const LANG_CODES = [
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az',
  'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs',
  'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy',
  'da', 'de', 'dv', 'dz',
  'ee', 'el', 'en', 'eo', 'es', 'et', 'eu',
  'fa', 'ff', 'fi', 'fj', 'fo', 'fr', 'fy',
  'ga', 'gd', 'gl', 'gn', 'gu', 'gv',
  'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu', 'hy', 'hz',
  'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is', 'it', 'iu',
  'ja', 'jv',
  'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky',
  'la', 'lb', 'lg', 'li', 'ln', 'lo', 'lt', 'lu', 'lv',
  'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my',
  'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny',
  'oc', 'oj', 'om', 'or', 'os',
  'pa', 'pi', 'pl', 'ps', 'pt',
  'qu',
  'rm', 'rn', 'ro', 'ru', 'rw',
  'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw', 'ty',
  'ug', 'uk', 'ur', 'uz',
  've', 'vi', 'vo',
  'wa', 'wo',
  'xh',
  'yi', 'yo',
  'za', 'zh', 'zu',
];

/** 一覧の先頭に置く言語。会場で使われる頻度が高いものから並べる。 */
const PINNED = ['ja', 'en', 'ko', 'zh', 'es', 'pt', 'fr', 'de'];

function displayNames(locale) {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' });
  } catch {
    return null;
  }
}

const jaNames = displayNames('ja');
const enNames = displayNames('en');

/** 表示用の名前 (日本語)。解決できなければコードをそのまま返す。 */
export function langLabel(code) {
  if (!code) return '';
  try {
    return (jaNames && jaNames.of(code)) || code;
  } catch {
    return code;
  }
}

/** 英語名と自言語での名前。検索と副表示に使う。 */
function langAliases(code) {
  const names = [];
  try {
    if (enNames) names.push(enNames.of(code));
  } catch {
    /* 解決できない言語は名前を足さない */
  }
  const native = displayNames(code);
  try {
    if (native) names.push(native.of(code));
  } catch {
    /* 同上 */
  }
  return names.filter((n) => n && n !== code);
}

/**
 * 一覧に出す言語。
 * `selected` に一覧外のコードが入っていても落とさず末尾に足す。
 */
export function listLangs(selected = []) {
  const codes = LANG_CODES.concat(selected.filter((c) => !LANG_CODES.includes(c)));
  const entries = codes.map((code) => {
    const label = langLabel(code);
    const aliases = langAliases(code);
    return {
      code,
      label,
      // 英語名と自言語名。同じ綴りは 1 つにまとめる。
      sub: [...new Set(aliases.filter((n) => n !== label))].join(' / '),
      search: [code, label, ...aliases].join(' ').toLowerCase(),
    };
  });

  const collator = new Intl.Collator('ja');
  return entries.sort((a, b) => {
    const ai = PINNED.indexOf(a.code);
    const bi = PINNED.indexOf(b.code);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return collator.compare(a.label, b.label);
  });
}

/** `en-US` → `en`。比較と保存はこの形で行う。 */
export function normalizeLang(tag) {
  return (tag || '').trim().toLowerCase().split('-')[0] || '';
}
