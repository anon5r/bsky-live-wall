import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval } from '../dist/ingest/wall.js';
import { buildTerms } from '../dist/shared/config.js';

const OPEN = { moderationMode: 'open', keywordRequireApproval: true };
const APPROVE = { moderationMode: 'approve', keywordRequireApproval: true };
const OPEN_KEYWORD_FREE = { moderationMode: 'open', keywordRequireApproval: false };

function terms(...input) {
  return buildTerms(input);
}

test('ハッシュタグ一致は公開モードならそのまま表示する', () => {
  const matched = terms({ value: 'myevent', type: 'hashtag' });
  assert.equal(needsApproval(matched, true, OPEN), false);
});

test('キーワードのみ一致は既定で承認待ちになる', () => {
  const matched = terms({ value: '基調講演', type: 'keyword' });
  assert.equal(needsApproval(matched, false, OPEN), true);
});

test("キーワードに 'never' を付けると、キーワードのみ一致でも即時表示する", () => {
  const matched = terms({ value: '基調講演', type: 'keyword', requireApproval: 'never' });
  assert.equal(needsApproval(matched, false, OPEN), false);
});

test("一致したキーワードに 1 つでも 'never' 以外があれば既定に従う", () => {
  const matched = terms(
    { value: '基調講演', type: 'keyword', requireApproval: 'never' },
    { value: '懇親会', type: 'keyword' }
  );
  assert.equal(needsApproval(matched, false, OPEN), true);
  assert.equal(needsApproval(matched, false, OPEN_KEYWORD_FREE), false);
});

test("'always' の語に一致したら、公開モードでも承認待ちにする", () => {
  const matched = terms({ value: 'myevent', type: 'hashtag', requireApproval: 'always' });
  assert.equal(needsApproval(matched, true, OPEN), true);
});

test("ウォールが承認モードなら 'never' の語でも承認待ちにする", () => {
  const matched = terms({ value: '基調講演', type: 'keyword', requireApproval: 'never' });
  assert.equal(needsApproval(matched, false, APPROVE), true);
});

test('キーワードのみ一致でも、ウォール設定が承認不要なら表示する', () => {
  const matched = terms({ value: '基調講演', type: 'keyword' });
  assert.equal(needsApproval(matched, false, OPEN_KEYWORD_FREE), false);
});

test('一致した語が無ければ承認は不要', () => {
  assert.equal(needsApproval([], false, OPEN), false);
});
