import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchHashtags } from '../dist/ingest/hashtag-matcher.js';

const TARGETS = ['myevent', 'マイイベント'];

function rec(partial) {
  return { text: '', createdAt: new Date().toISOString(), ...partial };
}

test('facets の richtext tag に一致する', () => {
  const r = rec({
    text: 'こんにちは #MyEvent',
    facets: [{ features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'MyEvent' }] }],
  });
  assert.deepEqual(matchHashtags(r, TARGETS), ['MyEvent']);
});

test('record.tags に一致する', () => {
  assert.deepEqual(matchHashtags(rec({ tags: ['myevent'] }), TARGETS), ['myevent']);
});

test('本文中のプレーンテキスト #タグ に一致する', () => {
  assert.deepEqual(matchHashtags(rec({ text: '楽しい #myevent です' }), TARGETS), ['myevent']);
});

test('大文字小文字を区別しない', () => {
  assert.deepEqual(matchHashtags(rec({ text: '#MYEVENT' }), TARGETS), ['MYEVENT']);
});

test('日本語タグに一致する', () => {
  assert.deepEqual(matchHashtags(rec({ text: '会場なう #マイイベント' }), TARGETS), ['マイイベント']);
});

test('全角 ＃ を認識する', () => {
  assert.deepEqual(matchHashtags(rec({ text: '＃マイイベント 最高' }), TARGETS), ['マイイベント']);
});

test('全角英数タグを NFKC 正規化して一致させる', () => {
  assert.deepEqual(matchHashtags(rec({ text: '#ｍｙｅｖｅｎｔ' }), TARGETS), ['ｍｙｅｖｅｎｔ']);
});

test('同じタグが複数経路で見つかっても重複しない', () => {
  const r = rec({
    text: '#myevent #myevent',
    tags: ['MyEvent'],
    facets: [{ features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'myevent' }] }],
  });
  assert.equal(matchHashtags(r, TARGETS).length, 1);
});

test('対象外のタグには一致しない', () => {
  assert.deepEqual(matchHashtags(rec({ text: '#otherevent' }), TARGETS), []);
});

test('前方一致・部分一致では誤検知しない', () => {
  assert.deepEqual(matchHashtags(rec({ text: '#myevent2026' }), TARGETS), []);
  assert.deepEqual(matchHashtags(rec({ text: 'myevent タグ無し' }), TARGETS), []);
});

test('タグは記号・空白で終端する', () => {
  assert.deepEqual(matchHashtags(rec({ text: '(#myevent)' }), TARGETS), ['myevent']);
  assert.deepEqual(matchHashtags(rec({ text: '#myevent、最高' }), TARGETS), ['myevent']);
  assert.deepEqual(matchHashtags(rec({ text: '#myevent\n次の行' }), TARGETS), ['myevent']);
});

test('facets が mention や link でも誤検知しない', () => {
  const r = rec({
    text: 'https://myevent.example.com',
    facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://myevent.example.com' }] }],
  });
  assert.deepEqual(matchHashtags(r, TARGETS), []);
});

test('監視タグが空なら常に不一致', () => {
  assert.deepEqual(matchHashtags(rec({ text: '#myevent' }), []), []);
});

test('複数の監視タグに同時一致する', () => {
  const matched = matchHashtags(rec({ text: '#myevent と #マイイベント' }), TARGETS);
  assert.equal(matched.length, 2);
});
