import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallManager } from '../dist/ingest/wall-manager.js';
import { loadConfig } from '../dist/shared/config.js';

/** hub の最小スタブ (wall-manager-approval.test.js と同じ形)。 */
function stubHub() {
  const listeners = new Map();
  return {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off() {},
    async start() {},
    async stop() {},
    getStatus: () => ({ connected: true, host: 'stub', reconnects: 0, backfilling: false }),
    getHosts: () => ['stub'],
    switchHost: () => true,
    startBackfill: () => ({ ok: true }),
    getBackfillStatus: () => ({ running: false, startedAt: 0, finishedAt: 0, minutes: 0 }),
    resolveAuthor: (did) => ({ did, handle: 'someone.bsky.social' }),
    emitCommit(event) {
      for (const listener of listeners.get('commit') ?? []) listener({ event, source: 'live' });
    },
  };
}

function tenant(settings = {}) {
  return {
    id: 't1',
    name: 'テスト',
    ownerDid: 'did:plc:owner',
    createdAt: 1,
    updatedAt: 1,
    settings: {
      title: 'テスト',
      subtitle: '',
      moderationMode: 'open',
      keywordRequireApproval: false,
      ngWords: [],
      ngPatterns: [],
      blockActors: [],
      allowReplies: true,
      filterLabeled: true,
      allowedLangs: [],
      startupBackfillMinutes: 0,
      ...settings,
    },
  };
}

let counter = 0;
function postEvent(text, langs) {
  counter += 1;
  return {
    did: 'did:plc:author',
    time_us: Date.now() * 1000 + counter,
    commit: {
      operation: 'create',
      collection: 'app.bsky.feed.post',
      rkey: 'rkey' + counter,
      cid: 'cid' + counter,
      record: {
        text,
        createdAt: new Date().toISOString(),
        ...(langs === undefined ? {} : { langs }),
      },
    },
  };
}

function setup(settings) {
  const hub = stubHub();
  const manager = new WallManager(loadConfig(), hub, tenant(settings));
  const wall = manager.getDefaultWall();
  wall.setTerms([{ value: '基調講演', type: 'keyword', requireApproval: 'never' }]);
  return { hub, manager, wall };
}

test('既定では言語を絞らない', () => {
  const { hub, wall } = setup();

  hub.emitCommit(postEvent('基調講演です', ['ja']));
  hub.emitCommit(postEvent('基調講演 keynote', ['en']));

  assert.equal(wall.getRecent(10).length, 2);
});

test('ウォールで言語を絞ると、一致しない投稿は取り込まない', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { allowedLangs: ['ja'] });

  hub.emitCommit(postEvent('基調講演です', ['ja']));
  hub.emitCommit(postEvent('基調講演 keynote', ['en']));

  const recent = wall.getRecent(10);
  assert.equal(recent.length, 1);
  assert.deepEqual(recent[0].langs, ['ja']);
});

test('複数の言語を指定できる', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { allowedLangs: ['ja', 'en'] });

  hub.emitCommit(postEvent('基調講演です', ['ja']));
  hub.emitCommit(postEvent('基調講演 keynote', ['en-US']));
  hub.emitCommit(postEvent('基調講演 기조연설', ['ko']));

  assert.equal(wall.getRecent(10).length, 2);
});

test('言語の指定が無い投稿は、絞り込み中は取り込まない', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { allowedLangs: ['ja'] });

  hub.emitCommit(postEvent('基調講演です', undefined));

  assert.equal(wall.getRecent(10).length, 0);
});

test('絞り込みを外すと、また全言語を取り込む', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { allowedLangs: ['ja'] });
  hub.emitCommit(postEvent('基調講演 keynote', ['en']));
  assert.equal(wall.getRecent(10).length, 0);

  manager.updateWall(wall.id, { allowedLangs: [] });
  hub.emitCommit(postEvent('基調講演 keynote again', ['en']));

  assert.equal(wall.getRecent(10).length, 1);
});

test('テナント設定で絞ると、どのウォールにも入らない', () => {
  const { hub, wall } = setup({ allowedLangs: ['ja'] });

  hub.emitCommit(postEvent('基調講演 keynote', ['en']));

  assert.equal(wall.getRecent(10).length, 0);
});

test('地域付きのタグ (en-US) は基底サブタグで判定する', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { allowedLangs: ['en'] });

  hub.emitCommit(postEvent('基調講演 keynote', ['en-US']));

  assert.equal(wall.getRecent(10).length, 1);
});
