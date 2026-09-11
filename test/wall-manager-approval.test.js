import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallManager } from '../dist/ingest/wall-manager.js';
import { loadConfig } from '../dist/shared/config.js';

/** hub の最小スタブ。commit を任意に流せるようにする。 */
function stubHub() {
  const listeners = new Map();
  return {
    listeners,
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
    emitBackfillCommit(event, tenantId = 't1') {
      for (const listener of listeners.get('commit') ?? []) {
        listener({ event, source: 'backfill', backfillOwner: tenantId });
      }
    },
    emitBackfillDone() {
      for (const listener of listeners.get('backfillDone') ?? []) listener();
    },
    emitProfile(did, author) {
      for (const listener of listeners.get('profile') ?? []) listener({ did, author });
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
      keywordRequireApproval: true,
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
function postEvent(text) {
  counter += 1;
  return {
    did: 'did:plc:author',
    time_us: Date.now() * 1000 + counter,
    commit: {
      operation: 'create',
      collection: 'app.bsky.feed.post',
      rkey: 'rkey' + counter,
      cid: 'cid' + counter,
      record: { text, createdAt: new Date().toISOString(), langs: ['ja'] },
    },
  };
}

function setup(settings) {
  const hub = stubHub();
  const manager = new WallManager(loadConfig(), hub, tenant(settings));
  const wall = manager.getDefaultWall();
  wall.setTerms([{ value: '基調講演', type: 'keyword' }]);
  return { hub, manager, wall };
}

test('ウォール設定が「そのまま表示する」ならキーワードのみ一致でも表示される', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });

  hub.emitCommit(postEvent('基調講演がはじまりました'));

  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getRecent(10).length, 1);
});

test('既定 (継承) ではキーワードのみ一致は承認待ちになる', () => {
  const { hub, wall } = setup();

  hub.emitCommit(postEvent('基調講演がはじまりました'));

  assert.equal(wall.getPending(10).length, 1);
  assert.equal(wall.getRecent(10).length, 0);
});

test('語ごとに「承認なしで表示する」を指定すれば表示される', () => {
  const { hub, wall } = setup();
  wall.setTerms([{ value: '基調講演', type: 'keyword', requireApproval: 'never' }]);

  hub.emitCommit(postEvent('基調講演がはじまりました'));

  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getRecent(10).length, 1);
});

test('承認不要に変更すると、溜まっていた承認待ちが表示へ移る', () => {
  const { hub, manager, wall } = setup();

  hub.emitCommit(postEvent('基調講演がはじまりました'));
  assert.equal(wall.getPending(10).length, 1);

  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });

  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getRecent(10).length, 1);
});

test('語ごとに承認不要へ変更した場合も承認待ちが表示へ移る', () => {
  const { hub, wall } = setup();

  hub.emitCommit(postEvent('基調講演がはじまりました'));
  assert.equal(wall.getPending(10).length, 1);

  wall.setTerms([{ value: '基調講演', type: 'keyword', requireApproval: 'never' }]);

  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getRecent(10).length, 1);
});

test('テナント設定を緩めた場合も、継承しているウォールの承認待ちが表示へ移る', () => {
  const { hub, manager, wall } = setup();

  hub.emitCommit(postEvent('基調講演がはじまりました'));
  assert.equal(wall.getPending(10).length, 1);

  manager.updateSettings({ keywordRequireApproval: false });

  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getRecent(10).length, 1);
});

test('承認モードのウォールでは、設定変更で承認待ちが勝手に表示されない', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { moderationMode: 'approve' });

  hub.emitCommit(postEvent('基調講演がはじまりました'));
  assert.equal(wall.getPending(10).length, 1);

  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });

  assert.equal(wall.getPending(10).length, 1);
  assert.equal(wall.getRecent(10).length, 0);
});

test('複数の承認待ちは投稿の古い順に表示へ移る', () => {
  const { hub, manager, wall } = setup();

  hub.emitCommit(postEvent('基調講演 その 1'));
  hub.emitCommit(postEvent('基調講演 その 2'));
  assert.equal(wall.getPending(10).length, 2);

  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });

  const recent = wall.getRecent(10);
  assert.equal(recent.length, 2);
  // getRecent は新しい順。後から届いたものが先頭に来る。
  assert.equal(recent[0].text, '基調講演 その 2');
  assert.equal(recent[1].text, '基調講演 その 1');
});

// ---------------------------------------------------------------------
// 除外キーワード
// ---------------------------------------------------------------------

test('除外キーワードを含む投稿は既定で破棄され、どこにも残らない', () => {
  const { hub, wall } = setup();
  wall.setExcludes({ terms: [{ value: 'ひどい' }] });

  hub.emitCommit(postEvent('基調講演はひどい内容でした'));

  assert.equal(wall.getRecent(10).length, 0);
  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getState().stats.rejected, 1);
});

test("扱いを 'approve' にすると、除外キーワードを含む投稿は承認待ちに入る", () => {
  const { hub, wall } = setup();
  wall.setExcludes({ terms: [{ value: 'ひどい' }], policy: 'approve' });

  hub.emitCommit(postEvent('基調講演はひどい内容でした'));

  const pending = wall.getPending(10);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].matchedExcludes, ['ひどい']);
  assert.equal(wall.getRecent(10).length, 0);
});

test('承認不要の設定でも、除外キーワードを含む投稿は表示されない', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });
  wall.setExcludes({ terms: [{ value: 'ひどい' }], policy: 'approve' });

  hub.emitCommit(postEvent('基調講演はひどい内容でした'));
  hub.emitCommit(postEvent('基調講演がよかった'));

  assert.equal(wall.getPending(10).length, 1);
  assert.equal(wall.getRecent(10).length, 1);
  assert.equal(wall.getRecent(10)[0].text, '基調講演がよかった');
});

test('除外キーワードで承認待ちにした投稿を却下すると、非表示リストにも残らない', () => {
  const { hub, manager, wall } = setup();
  wall.setExcludes({ terms: [{ value: 'ひどい' }], policy: 'approve' });

  hub.emitCommit(postEvent('基調講演はひどい内容でした'));
  const [post] = wall.getPending(10);

  assert.equal(manager.hide(post.uri), true);
  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getRecent(10).length, 0);
  assert.equal(manager.getHidden(10).length, 0);
});

test('通常の投稿を却下した場合は、これまでどおり非表示リストに残る', () => {
  const { hub, manager, wall } = setup();

  hub.emitCommit(postEvent('基調講演がはじまりました'));
  const [post] = wall.getPending(10);

  assert.equal(manager.hide(post.uri), true);
  assert.equal(manager.getHidden(10).length, 1);
});

test('除外キーワードを外すと、承認待ちの印も外れて通常の判定に戻る', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });
  wall.setExcludes({ terms: [{ value: 'ひどい' }], policy: 'approve' });

  hub.emitCommit(postEvent('基調講演はひどい内容でした'));
  assert.equal(wall.getPending(10).length, 1);

  wall.setExcludes({ terms: [] });

  assert.equal(wall.getPending(10).length, 0);
  assert.equal(wall.getRecent(10).length, 1);
});

test('除外キーワードは管理 API 向けの一覧にだけ載り、ウォール状態には載らない', () => {
  const { manager, wall } = setup();
  wall.setExcludes({ terms: [{ value: 'ひどい' }] });

  const summary = manager.getWalls().find((w) => w.id === wall.id);
  assert.deepEqual(summary.excludeTerms.map((t) => t.value), ['ひどい']);
  assert.equal(summary.excludePolicy, 'reject');
  // 会場モニターへ配る WallState にネガティブワードを載せない。
  assert.equal('excludeTerms' in wall.getState(), false);
});

// ---------------------------------------------------------------------
// 取り込み (バックフィル) のプロフィール
// ---------------------------------------------------------------------

test('取り込み中に解決したプロフィールが、確定した投稿に反映される', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });

  hub.emitBackfillCommit(postEvent('基調講演がはじまりました'));
  // 取り込み待ちの間にプロフィールが解決した状況を作る。
  hub.emitProfile('did:plc:author', {
    did: 'did:plc:author',
    handle: 'alice.bsky.social',
    displayName: 'アリス',
    avatar: 'https://example.com/a.jpg',
  });
  hub.emitBackfillDone();

  const [post] = wall.getRecent(10);
  assert.equal(post.author.displayName, 'アリス');
  assert.equal(post.author.avatar, 'https://example.com/a.jpg');
});

test('取り込み確定時にプロフィールが解決済みなら、その場で反映される', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });

  hub.emitBackfillCommit(postEvent('基調講演がはじまりました'));
  // hub 側のキャッシュが解決済みになった状況 (profile イベントは流れない)。
  hub.resolveAuthor = (did) => ({
    did,
    handle: 'alice.bsky.social',
    displayName: 'アリス',
    avatar: 'https://example.com/a.jpg',
  });
  hub.emitBackfillDone();

  const [post] = wall.getRecent(10);
  assert.equal(post.author.displayName, 'アリス');
  assert.equal(post.author.avatar, 'https://example.com/a.jpg');
});

test('未解決のままなら、分かっているハンドルを仮の値で潰さない', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });

  hub.emitBackfillCommit(postEvent('基調講演がはじまりました'));
  // 未解決のときはハンドルに DID が入った仮の値が返る。
  hub.resolveAuthor = (did) => ({ did, handle: did });
  hub.emitBackfillDone();

  const [post] = wall.getRecent(10);
  assert.equal(post.author.handle, 'someone.bsky.social');
});

// ---------------------------------------------------------------------
// 画面モード
// ---------------------------------------------------------------------

test('待機モードは投稿が表示された時点で通常へ戻る', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });
  wall.setScreen({ mode: 'waiting' });

  hub.emitCommit(postEvent('基調講演がはじまりました'));

  assert.equal(wall.getScreen().screen.mode, 'wall');
  assert.equal(wall.getRecent(10).length, 1);
});

test('自動で戻す設定を切ると、待機モードのままになる', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });
  wall.setScreen({ mode: 'waiting', autoResume: false });

  hub.emitCommit(postEvent('基調講演がはじまりました'));

  assert.equal(wall.getScreen().screen.mode, 'waiting');
});

test('休憩・終演は投稿が届いても切り替わらない', () => {
  const { hub, manager, wall } = setup();
  manager.updateWall(wall.id, { keywordRequireApproval: 'never' });
  wall.setScreen({ mode: 'break' });

  hub.emitCommit(postEvent('基調講演がはじまりました'));

  assert.equal(wall.getScreen().screen.mode, 'break');
  // 受信そのものは止まらない。戻したときに流せるよう投稿は溜まっている。
  assert.equal(wall.getRecent(10).length, 1);
});

test('承認待ちに入った投稿では待機モードを解除しない', () => {
  const { hub, wall } = setup();
  wall.setScreen({ mode: 'waiting' });

  hub.emitCommit(postEvent('基調講演がはじまりました'));

  assert.equal(wall.getPending(10).length, 1);
  assert.equal(wall.getScreen().screen.mode, 'waiting');
});

test('画像を消すと表示設定も落ちる', () => {
  const { wall } = setup();
  wall.setScreenImage({ file: 'abc.png', mime: 'image/png', updatedAt: 1 });
  wall.setScreen({ showImage: true });
  assert.match(wall.getScreen().imageUrl, /^\/uploads\/abc\.png\?v=1$/);

  const after = wall.setScreenImage(null);
  assert.equal(after.imageUrl, null);
  assert.equal(after.screen.showImage, false);
});
