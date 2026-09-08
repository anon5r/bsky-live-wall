import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostStore } from '../dist/ingest/post-store.js';

let seq = 0;
function post(overrides = {}) {
  seq += 1;
  return {
    uri: `at://did:plc:a${seq}/app.bsky.feed.post/r${seq}`,
    cid: 'cid',
    rkey: `r${seq}`,
    did: `did:plc:a${seq}`,
    author: { did: `did:plc:a${seq}`, handle: `a${seq}.example` },
    text: 'hello',
    matchedTags: ['tag'],
    images: [],
    langs: [],
    isReply: false,
    createdAt: new Date().toISOString(),
    receivedAt: Date.now(),
    timeUs: Date.now() * 1000 + seq,
    webUrl: 'https://bsky.app/',
    status: 'visible',
    ...overrides,
  };
}

const store = () => new PostStore({ size: 100, pendingSize: 100 });

test('表示すると displayed が増える', () => {
  const s = store();
  s.add(post());
  s.add(post());
  assert.equal(s.getStats().displayed, 2);
});

test('投稿者による削除で displayed が減る', () => {
  const s = store();
  const p = post();
  s.add(p);
  s.add(post());
  s.remove(p.uri, 'deleted');
  assert.equal(s.getStats().displayed, 1);
});

test('運営による非表示でも displayed が減る', () => {
  const s = store();
  const p = post();
  s.add(p);
  s.remove(p.uri, 'hidden');
  assert.equal(s.getStats().displayed, 0);
});

test('画面の全消去では displayed を減らさない', () => {
  const s = store();
  const p = post();
  s.add(p);
  s.remove(p.uri, 'cleared');
  assert.equal(s.getStats().displayed, 1);
});

test('存在しない uri を消しても displayed は変わらない', () => {
  const s = store();
  s.add(post());
  s.remove('at://did:plc:nope/app.bsky.feed.post/x', 'deleted');
  assert.equal(s.getStats().displayed, 1);
});

test('非表示にした投稿を戻すと displayed が元に戻る', () => {
  const s = store();
  const p = post();
  s.add(p);
  s.remove(p.uri, 'hidden');
  s.add(p);
  assert.equal(s.getStats().displayed, 1);
});

test('displayed が負にならない', () => {
  const s = store();
  const p = post();
  s.add(p);
  s.remove(p.uri, 'deleted');
  s.add(p);
  s.remove(p.uri, 'deleted');
  s.remove(p.uri, 'deleted');
  assert.equal(s.getStats().displayed, 0);
});

test('承認待ちは displayed に数えない', () => {
  const s = store();
  const p = post({ status: 'pending' });
  s.addPending(p);
  assert.equal(s.getStats().displayed, 0);
  s.remove(p.uri, 'hidden');
  assert.equal(s.getStats().displayed, 0);
});

test('承認すると displayed に数える', () => {
  const s = store();
  const p = post({ status: 'pending' });
  s.addPending(p);
  s.promotePending(p.uri);
  assert.equal(s.getStats().displayed, 1);
});

test('過去分の取り込みも displayed に数える', () => {
  const s = store();
  s.addHistory([post(), post(), post()]);
  assert.equal(s.getStats().displayed, 3);
});
