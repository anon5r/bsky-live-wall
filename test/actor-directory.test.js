import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActorDirectory } from '../dist/server/actor-directory.js';

const config = { appview: { url: 'https://appview.test' } };

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

test('プロフィールを DID で引ける', async () => {
  const stub = withFetch(() =>
    jsonResponse({
      profiles: [
        { did: 'did:plc:a', handle: 'alice.test', displayName: 'Alice', avatar: 'https://cdn/a.jpg' },
      ],
    })
  );
  try {
    const dir = createActorDirectory(config);
    const found = await dir.profiles(['did:plc:a']);
    assert.deepEqual(found.get('did:plc:a'), {
      did: 'did:plc:a',
      handle: 'alice.test',
      displayName: 'Alice',
      avatar: 'https://cdn/a.jpg',
    });
  } finally {
    stub.restore();
  }
});

test('一度引いた DID はキャッシュから返し、二度目は問い合わせない', async () => {
  const stub = withFetch(() => jsonResponse({ profiles: [{ did: 'did:plc:a', handle: 'alice.test' }] }));
  try {
    const dir = createActorDirectory(config);
    await dir.profiles(['did:plc:a']);
    await dir.profiles(['did:plc:a']);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('取得に失敗しても一覧は壊さず、引けた分だけ返す', async () => {
  const stub = withFetch(() => ({ ok: false, status: 502, json: async () => ({}) }));
  try {
    const dir = createActorDirectory(config);
    const found = await dir.profiles(['did:plc:a']);
    assert.equal(found.size, 0);
  } finally {
    stub.restore();
  }
});

test('候補検索は typeahead を叩き、@ を落として問い合わせる', async () => {
  const stub = withFetch(() =>
    jsonResponse({ actors: [{ did: 'did:plc:b', handle: 'bob.test', displayName: 'Bob' }] })
  );
  try {
    const dir = createActorDirectory(config);
    const actors = await dir.search('@bob');
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
    const dir = createActorDirectory(config);
    assert.deepEqual(await dir.search('   '), []);
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
    const dir = createActorDirectory(config);
    assert.deepEqual(await dir.search('bob'), []);
  } finally {
    stub.restore();
  }
});
