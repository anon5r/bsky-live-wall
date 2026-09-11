import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLang, normalizeLangs, matchesLang } from '../dist/shared/lang.js';

test('地域付きのタグは基底サブタグに寄せる', () => {
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang(' JA '), 'ja');
  assert.equal(normalizeLang('zh-Hant'), 'zh');
});

test('重複と空は落とす', () => {
  assert.deepEqual(normalizeLangs(['ja', 'ja-JP', '', 'en-US', 'en']), ['ja', 'en']);
  assert.deepEqual(normalizeLangs(undefined), []);
});

test('絞り込みが空なら全言語を通す', () => {
  assert.equal(matchesLang(['ja'], []), true);
  assert.equal(matchesLang([], []), true);
});

test('指定した言語に一致すれば通す (地域違いも通す)', () => {
  assert.equal(matchesLang(['ja'], ['ja']), true);
  assert.equal(matchesLang(['en-US'], ['en']), true);
  assert.equal(matchesLang(['ja', 'en'], ['en']), true);
});

test('一致しない言語は落とす', () => {
  assert.equal(matchesLang(['ko'], ['ja', 'en']), false);
});

test('言語が付いていない投稿は、絞り込みが有効なときは落とす', () => {
  assert.equal(matchesLang([], ['ja']), false);
  assert.equal(matchesLang(undefined, ['ja']), false);
});
