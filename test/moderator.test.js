import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../dist/ingest/moderator.js';

const AUTHOR = { did: 'did:plc:abc', handle: 'alice.bsky.social' };

/** 既定 (何も制限しない) のモデレーション設定 */
function cfg(overrides = {}) {
  return {
    mode: 'open',
    ngWords: [],
    ngPatterns: [],
    blockActors: [],
    allowReplies: true,
    filterLabeled: true,
    allowedLangs: [],
    ...overrides,
  };
}

const rec = (partial = {}) => ({ text: '', createdAt: new Date().toISOString(), ...partial });

test('制限が無ければ通過する', () => {
  assert.equal(evaluate(rec({ text: 'こんにちは' }), AUTHOR, cfg()).ok, true);
});

test('NG ワードを含む投稿を弾く', () => {
  const r = evaluate(rec({ text: 'これは spam です' }), AUTHOR, cfg({ ngWords: ['spam'] }));
  assert.equal(r.ok, false);
});

test('NG ワードは大文字小文字を無視する', () => {
  assert.equal(evaluate(rec({ text: 'SPAM!' }), AUTHOR, cfg({ ngWords: ['spam'] })).ok, false);
});

test('NG 正規表現で弾く', () => {
  const cfgv = cfg({ ngPatterns: [/https?:\/\/bad\.example/iu] });
  assert.equal(evaluate(rec({ text: 'http://bad.example/x' }), AUTHOR, cfgv).ok, false);
  assert.equal(evaluate(rec({ text: 'http://good.example/x' }), AUTHOR, cfgv).ok, true);
});

test('ブロック DID を弾く', () => {
  assert.equal(evaluate(rec(), AUTHOR, cfg({ blockActors: ['did:plc:abc'] })).ok, false);
});

test('ブロックはハンドルでも効く', () => {
  assert.equal(evaluate(rec(), AUTHOR, cfg({ blockActors: ['alice.bsky.social'] })).ok, false);
});

test('ALLOW_REPLIES=false でリプライを弾く', () => {
  const r = rec({ reply: { parent: { uri: 'at://x' }, root: { uri: 'at://x' } } });
  assert.equal(evaluate(r, AUTHOR, cfg({ allowReplies: false })).ok, false);
  assert.equal(evaluate(r, AUTHOR, cfg({ allowReplies: true })).ok, true);
});

test('成人向けラベル付き投稿を弾く', () => {
  const r = rec({ labels: { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'porn' }] } });
  assert.equal(evaluate(r, AUTHOR, cfg({ filterLabeled: true })).ok, false);
  assert.equal(evaluate(r, AUTHOR, cfg({ filterLabeled: false })).ok, true);
});

test('無関係なラベルは弾かない', () => {
  const r = rec({ labels: { values: [{ val: 'spoiler' }] } });
  assert.equal(evaluate(r, AUTHOR, cfg({ filterLabeled: true })).ok, true);
});

test('ALLOWED_LANGS 指定時は対象外言語を弾く', () => {
  const cfgv = cfg({ allowedLangs: ['ja'] });
  assert.equal(evaluate(rec({ langs: ['ja'] }), AUTHOR, cfgv).ok, true);
  assert.equal(evaluate(rec({ langs: ['en'] }), AUTHOR, cfgv).ok, false);
});

test('ALLOWED_LANGS が空なら全言語を通す', () => {
  assert.equal(evaluate(rec({ langs: ['en'] }), AUTHOR, cfg()).ok, true);
});

test('弾いた理由が返る', () => {
  const r = evaluate(rec({ text: 'spam' }), AUTHOR, cfg({ ngWords: ['spam'] }));
  assert.equal(typeof r.reason, 'string');
});
