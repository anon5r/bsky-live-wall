import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnTo } from '../dist/server/routes/oauth.js';

test('テナント直リンクの管理画面はそのまま戻り先にする', () => {
  assert.equal(safeReturnTo('/e/my-event/admin'), '/e/my-event/admin');
  assert.equal(safeReturnTo('/e/my-event/admin/'), '/e/my-event/admin/');
});

test('テナント指定なしの管理画面もそのまま戻り先にする', () => {
  assert.equal(safeReturnTo('/admin'), '/admin');
  assert.equal(safeReturnTo('/admin/'), '/admin/');
});

test('管理画面以外は既定の /admin に落とす', () => {
  assert.equal(safeReturnTo('/e/my-event/wall'), '/admin');
  assert.equal(safeReturnTo('/wall/main'), '/admin');
  assert.equal(safeReturnTo(''), '/admin');
  assert.equal(safeReturnTo(undefined), '/admin');
  assert.equal(safeReturnTo(42), '/admin');
});

test('外部サイトへ誘導する値は受け付けない', () => {
  assert.equal(safeReturnTo('https://example.com/admin'), '/admin');
  assert.equal(safeReturnTo('//example.com/admin'), '/admin');
  assert.equal(safeReturnTo('/e/x/admin?next=https://example.com'), '/admin');
  assert.equal(safeReturnTo('/e/../admin'), '/admin');
});
