import { test } from 'node:test';
import assert from 'node:assert/strict';
// 管理画面から AppView を直接叩く処理。ブラウザ用だが素の ESM なのでそのまま読める。
import { setAppviewUrl, fetchProfiles, searchActors } from '../src/admin/lib/bsky.js';

/** fetch を差し替えて、呼ばれた URL を記録する。 */
function withFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('既定では公開 AppView を叩く', async () => {
  const stub = withFetch(() => jsonResponse({ actors: [] }));
  try {
    await searchActors('alice');
    assert.match(stub.calls[0], /^https:\/\/public\.api\.bsky\.app\/xrpc\//);
  } finally {
    stub.restore();
  }
});

test('サーバーから受け取った AppView を宛先にする', async () => {
  const stub = withFetch(() => jsonResponse({ actors: [] }));
  try {
    setAppviewUrl('https://appview.test/');
    await searchActors('alice');
    assert.match(stub.calls[0], /^https:\/\/appview\.test\/xrpc\//);
  } finally {
    setAppviewUrl('https://public.api.bsky.app');
    stub.restore();
  }
});

test('候補検索は @ を落として typeahead を叩く', async () => {
  const stub = withFetch(() =>
    jsonResponse({ actors: [{ did: 'did:plc:b1', handle: 'bob.test', displayName: 'Bob' }] })
  );
  try {
    const actors = await searchActors('@bob');
    assert.equal(actors.length, 1);
    assert.equal(actors[0].handle, 'bob.test');
    assert.match(stub.calls[0], /searchActorsTypeahead\?q=bob&limit=8$/);
  } finally {
    stub.restore();
  }
});

test('空の検索語では問い合わせない', async () => {
  const stub = withFetch(() => jsonResponse({ actors: [] }));
  try {
    assert.deepEqual(await searchActors('   '), []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('候補検索が失敗しても空で返す (入力を妨げない)', async () => {
  const stub = withFetch(() => {
    throw new Error('network');
  });
  try {
    assert.deepEqual(await searchActors('bob'), []);
  } finally {
    stub.restore();
  }
});

test('プロフィールは一度引いたらキャッシュから返す', async () => {
  const stub = withFetch(() =>
    jsonResponse({
      profiles: [
        { did: 'did:plc:c1', handle: 'carol.test', displayName: 'Carol', avatar: 'https://cdn/c.jpg' },
      ],
    })
  );
  try {
    const first = await fetchProfiles(['did:plc:c1']);
    assert.equal(first.get('did:plc:c1').avatar, 'https://cdn/c.jpg');
    await fetchProfiles(['did:plc:c1']);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('プロフィールを引けなくても結果に入れないだけで落ちない', async () => {
  const stub = withFetch(() => ({ ok: false, status: 502, json: async () => ({}) }));
  try {
    const found = await fetchProfiles(['did:plc:d1']);
    assert.equal(found.size, 0);
  } finally {
    stub.restore();
  }
});
