/**
 * 言語フィルタで選べる言語。
 *
 * Bluesky の投稿は BCP-47 で言語を持つ。ここでは基底のサブタグだけを扱う
 * (`en` を選べば `en-US` の投稿も拾う)。一覧に無い言語は自由入力で足せる。
 */
export const LANG_PRESETS = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: '英語' },
  { code: 'ko', label: '韓国語' },
  { code: 'zh', label: '中国語' },
  { code: 'es', label: 'スペイン語' },
  { code: 'pt', label: 'ポルトガル語' },
  { code: 'fr', label: 'フランス語' },
  { code: 'de', label: 'ドイツ語' },
  { code: 'it', label: 'イタリア語' },
  { code: 'ru', label: 'ロシア語' },
  { code: 'uk', label: 'ウクライナ語' },
  { code: 'nl', label: 'オランダ語' },
  { code: 'pl', label: 'ポーランド語' },
  { code: 'tr', label: 'トルコ語' },
  { code: 'id', label: 'インドネシア語' },
  { code: 'th', label: 'タイ語' },
  { code: 'vi', label: 'ベトナム語' },
  { code: 'ar', label: 'アラビア語' },
  { code: 'hi', label: 'ヒンディー語' },
];

/** `en-US` → `en`。比較と保存はこの形で行う。 */
export function normalizeLang(tag) {
  return (tag || '').trim().toLowerCase().split('-')[0] || '';
}

/** 表示用の名前。一覧に無ければコードをそのまま返す。 */
export function langLabel(code) {
  const found = LANG_PRESETS.find((l) => l.code === code);
  return found ? found.label : code;
}

/** 言語コードとして妥当か (BCP-47 の形)。 */
export function isValidLang(tag) {
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test((tag || '').trim());
}
