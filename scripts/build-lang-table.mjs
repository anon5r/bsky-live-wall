/**
 * src/admin/lib/langs.js の言語表を作り直す。
 *
 * ブラウザの ICU は搭載データが小さく、少数言語の名前を解決できない。
 * ここで Node のフル ICU から名前を取り出して埋め込み、どの環境でも
 * 同じ名前・同じ並びになるようにする。
 *
 *   node scripts/build-lang-table.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';

const TARGET = new URL('../src/admin/lib/langs.js', import.meta.url);
/** 一覧の先頭に固定する言語。会場で使われる頻度が高いものから並べる。 */
const PINNED = ['ja', 'en', 'ko', 'zh', 'es', 'pt', 'fr', 'de'];

const source = await readFile(TARGET, 'utf8');
const codes = [...source.matchAll(/^ {2}\["([a-z]{2})",/gm)].map((m) => m[1]);
if (codes.length === 0) throw new Error('言語コードを読み取れませんでした');

const ja = new Intl.DisplayNames(['ja'], { type: 'language' });
const en = new Intl.DisplayNames(['en'], { type: 'language' });

const entries = codes.map((code) => {
  const label = ja.of(code);
  if (label === code) throw new Error(`名前を解決できません (ICU が不足): ${code}`);
  const names = [];
  const english = en.of(code);
  if (english && english !== label) names.push(english);
  try {
    const native = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (native && native !== label && !names.includes(native)) names.push(native);
  } catch {
    // 自言語での名前が引けない言語は英語名だけにする。
  }
  return { code, label, sub: names.join(' / ') };
});

const collator = new Intl.Collator('ja');
entries.sort((a, b) => {
  const ai = PINNED.indexOf(a.code);
  const bi = PINNED.indexOf(b.code);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  return collator.compare(a.label, b.label);
});

const table = entries
  .map((e) => `  [${JSON.stringify(e.code)}, ${JSON.stringify(e.label)}, ${JSON.stringify(e.sub)}],`)
  .join('\n');
const replaced = source.replace(
  /const LANG_TABLE = \[\n[\s\S]*?\n\];/,
  `const LANG_TABLE = [\n${table}\n];`
);
await writeFile(TARGET, replaced);
console.log(`言語表を更新しました: ${entries.length} 件`);
