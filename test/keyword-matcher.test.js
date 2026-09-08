import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchKeywords } from '../dist/ingest/keyword-matcher.js';
import { buildTerms } from '../dist/shared/config.js';

const terms = buildTerms([
  { value: 'myevent2026', type: 'hashtag' },
  { value: '基調講演', type: 'keyword' },
  { value: 'Keynote', type: 'keyword' },
]);

const rec = (text) => ({ text, createdAt: new Date().toISOString() });

test('本文にキーワードが含まれれば一致する', () => {
  assert.deepEqual(matchKeywords(rec('いよいよ基調講演がはじまる'), terms), ['基調講演']);
});

test('大文字小文字を区別しない', () => {
  assert.deepEqual(matchKeywords(rec('the KEYNOTE was great'), terms), ['Keynote']);
});

test('全角英数を NFKC 正規化して一致させる', () => {
  assert.deepEqual(matchKeywords(rec('ｋｅｙｎｏｔｅ 最高'), terms), ['Keynote']);
});

test('複数のキーワードに同時一致する', () => {
  const matched = matchKeywords(rec('基調講演 = keynote'), terms);
  assert.equal(matched.length, 2);
});

test('ハッシュタグはキーワード判定の対象にしない', () => {
  assert.deepEqual(matchKeywords(rec('#myevent2026 だけの投稿'), terms), []);
});

test('一致しない本文では空になる', () => {
  assert.deepEqual(matchKeywords(rec('関係のない投稿'), terms), []);
});

test('本文が空でも落ちない', () => {
  assert.deepEqual(matchKeywords(rec(''), terms), []);
  assert.deepEqual(matchKeywords({ createdAt: '' }, terms), []);
});

test('キーワードが未設定なら常に空', () => {
  const only = buildTerms([{ value: 'tag', type: 'hashtag' }]);
  assert.deepEqual(matchKeywords(rec('tag を含む本文'), only), []);
});

test('buildTerms は種別ごとに重複を除く', () => {
  const t = buildTerms([
    { value: '#Event', type: 'hashtag' },
    { value: 'event', type: 'hashtag' },
    { value: 'event', type: 'keyword' },
  ]);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.type), ['hashtag', 'keyword']);
});

test('buildTerms はハッシュタグの先頭の # を落とす', () => {
  const t = buildTerms([{ value: '＃全角タグ', type: 'hashtag' }]);
  assert.equal(t[0].value, '全角タグ');
});

test('buildTerms は空文字を除く', () => {
  const t = buildTerms([{ value: '  ', type: 'keyword' }, { value: 'ok', type: 'keyword' }]);
  assert.equal(t.length, 1);
});
