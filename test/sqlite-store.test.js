import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteTenantStore } from '../dist/store/sqlite-store.js';

function store() {
  return new SqliteTenantStore(':memory:');
}

function makeTenantInput(overrides = {}) {
  return {
    id: 'my-event',
    name: 'My Event',
    ownerDid: 'did:plc:owner1',
    ownerHandle: 'owner1.example',
    ...overrides,
  };
}

function makeWall(tenantId, overrides = {}) {
  return {
    tenantId,
    id: 'wall-a',
    name: 'Wall A',
    terms: [],
    display: { maxCards: 40, columns: 1, cardTtlSec: 0, showImages: true },
    isDefault: false,
    position: 0,
    ...overrides,
  };
}

test('テナントの作成・取得・一覧・更新・削除', () => {
  const s = store();
  const created = s.createTenant(makeTenantInput());
  assert.equal(created.id, 'my-event');
  assert.equal(created.name, 'My Event');
  assert.equal(created.settings.title, 'Bluesky Live Wall');

  const fetched = s.getTenant('my-event');
  assert.ok(fetched);
  assert.equal(fetched.ownerDid, 'did:plc:owner1');

  assert.equal(s.listTenants().length, 1);

  const updated = s.updateTenant('my-event', { name: 'Renamed' });
  assert.equal(updated.name, 'Renamed');
  assert.ok(updated.updatedAt >= created.createdAt);

  assert.equal(s.deleteTenant('my-event'), true);
  assert.equal(s.getTenant('my-event'), undefined);
  assert.equal(s.deleteTenant('my-event'), false);

  s.close();
});

test('作成時にオーナーが member として登録される', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  const members = s.listMembers('my-event');
  assert.equal(members.length, 1);
  assert.equal(members[0].did, 'did:plc:owner1');
  assert.equal(members[0].role, 'owner');
  s.close();
});

test('ID の正規化', () => {
  const s = store();
  const created = s.createTenant(makeTenantInput({ id: 'My Event' }));
  assert.equal(created.id, 'my-event');
  s.close();
});

test('予約語の ID は拒否される', () => {
  const s = store();
  assert.throws(() => s.createTenant(makeTenantInput({ id: 'admin' })));
  s.close();
});

test('重複 ID は拒否される', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  assert.throws(() => s.createTenant(makeTenantInput({ ownerDid: 'did:plc:owner2' })));
  s.close();
});

test('空文字に正規化される ID は拒否される', () => {
  const s = store();
  assert.throws(() => s.createTenant(makeTenantInput({ id: '???' })));
  s.close();
});

test('settings の部分更新は既存値を壊さない', () => {
  const s = store();
  s.createTenant(makeTenantInput({ settings: { title: 'Custom Title', ngWords: ['ng1'] } }));
  const updated = s.updateTenant('my-event', { settings: { subtitle: 'sub' } });
  assert.equal(updated.settings.title, 'Custom Title');
  assert.deepEqual(updated.settings.ngWords, ['ng1']);
  assert.equal(updated.settings.subtitle, 'sub');
  s.close();
});

test('テナント削除で members / walls / modlists も消える', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.addMember({ tenantId: 'my-event', did: 'did:plc:mod1', handle: 'mod1.example', role: 'moderator' });
  s.upsertWall(makeWall('my-event'));
  s.addModList('my-event', 'at://did:plc:x/app.bsky.graph.list/abc');

  assert.equal(s.deleteTenant('my-event'), true);
  assert.equal(s.listMembers('my-event').length, 0);
  assert.equal(s.listWalls('my-event').length, 0);
  assert.equal(s.listModLists('my-event').length, 0);
  s.close();
});

test('オーナーが 1 人しかいない状態でその人を削除しようとすると false が返り削除されない', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  const removed = s.removeMember('my-event', 'did:plc:owner1');
  assert.equal(removed, false);
  assert.equal(s.listMembers('my-event').length, 1);
  s.close();
});

test('オーナーが複数いる場合は削除できる', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.addMember({ tenantId: 'my-event', did: 'did:plc:owner2', handle: 'owner2.example', role: 'owner' });
  const removed = s.removeMember('my-event', 'did:plc:owner1');
  assert.equal(removed, true);
  assert.equal(s.listMembers('my-event').length, 1);
  s.close();
});

test('findTenantsForDid が該当テナントだけを返す', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.createTenant(makeTenantInput({ id: 'other-event', ownerDid: 'did:plc:owner2', ownerHandle: 'owner2.example' }));
  s.addMember({ tenantId: 'my-event', did: 'did:plc:mod1', handle: 'mod1.example', role: 'moderator' });

  const found = s.findTenantsForDid('did:plc:mod1');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'my-event');
  s.close();
});

test('getMemberRole が正しい role を返し、非メンバーには undefined を返す', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  assert.equal(s.getMemberRole('my-event', 'did:plc:owner1'), 'owner');
  assert.equal(s.getMemberRole('my-event', 'did:plc:nobody'), undefined);
  s.close();
});

test('ウォールの upsert / 一覧 (position 順) / 削除', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(makeWall('my-event', { id: 'wall-b', position: 1 }));
  s.upsertWall(makeWall('my-event', { id: 'wall-a', position: 0 }));

  const walls = s.listWalls('my-event');
  assert.deepEqual(walls.map((w) => w.id), ['wall-a', 'wall-b']);

  s.upsertWall(makeWall('my-event', { id: 'wall-a', name: 'Renamed', position: 0 }));
  assert.equal(s.listWalls('my-event')[0].name, 'Renamed');

  assert.equal(s.deleteWall('my-event', 'wall-b'), true);
  assert.equal(s.listWalls('my-event').length, 1);
  s.close();
});

test('is_default が同一テナント内で 1 つだけになる', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(makeWall('my-event', { id: 'wall-a', isDefault: true, position: 0 }));
  s.upsertWall(makeWall('my-event', { id: 'wall-b', isDefault: true, position: 1 }));

  const walls = s.listWalls('my-event');
  const defaults = walls.filter((w) => w.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].id, 'wall-b');
  s.close();
});

test('既定ウォールは削除できない', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(makeWall('my-event', { id: 'wall-a', isDefault: true, position: 0 }));

  const removed = s.deleteWall('my-event', 'wall-a');
  assert.equal(removed, false);
  assert.equal(s.listWalls('my-event').length, 1);
  s.close();
});

test('モデレーションリストの追加・一覧・削除', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  const uri = 'at://did:plc:x/app.bsky.graph.list/abc';
  s.addModList('my-event', uri);
  assert.equal(s.listModLists('my-event').length, 1);

  assert.equal(s.removeModList('my-event', uri), true);
  assert.equal(s.listModLists('my-event').length, 0);
  s.close();
});

test('同じ URI を二重に追加しても 1 件のまま', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  const uri = 'at://did:plc:x/app.bsky.graph.list/abc';
  s.addModList('my-event', uri);
  s.addModList('my-event', uri);
  assert.equal(s.listModLists('my-event').length, 1);
  s.close();
});

test('承認設定を指定しないウォールは継承 (inherit) として保存される', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(makeWall('my-event'));

  const [wall] = s.listWalls('my-event');
  assert.equal(wall.moderationMode, 'inherit');
  assert.equal(wall.keywordRequireApproval, 'inherit');
  s.close();
});

test('ウォールごとの承認設定と語ごとの承認設定が往復する', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(
    makeWall('my-event', {
      moderationMode: 'approve',
      keywordRequireApproval: 'never',
      terms: [
        { value: '基調講演', type: 'keyword', normalized: '基調講演', requireApproval: 'never' },
        { value: 'myevent', type: 'hashtag', normalized: 'myevent', requireApproval: 'always' },
      ],
    })
  );

  const [wall] = s.listWalls('my-event');
  assert.equal(wall.moderationMode, 'approve');
  assert.equal(wall.keywordRequireApproval, 'never');
  assert.equal(wall.terms[0].requireApproval, 'never');
  assert.equal(wall.terms[1].requireApproval, 'always');
  s.close();
});

test('想定外の値が入っていても継承として読み出す', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(makeWall('my-event', { moderationMode: 'bogus', keywordRequireApproval: 'bogus' }));

  const [wall] = s.listWalls('my-event');
  assert.equal(wall.moderationMode, 'inherit');
  assert.equal(wall.keywordRequireApproval, 'inherit');
  s.close();
});

test('除外キーワードと扱いが往復する', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(
    makeWall('my-event', {
      excludeTerms: [{ value: 'ひどい', normalized: 'ひどい' }],
      excludePolicy: 'approve',
    })
  );

  const [wall] = s.listWalls('my-event');
  assert.deepEqual(wall.excludeTerms, [{ value: 'ひどい', normalized: 'ひどい' }]);
  assert.equal(wall.excludePolicy, 'approve');
  s.close();
});

test('除外キーワードを指定しないウォールは「除外なし・自動で非承認」で始まる', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(makeWall('my-event'));

  const [wall] = s.listWalls('my-event');
  assert.deepEqual(wall.excludeTerms, []);
  assert.equal(wall.excludePolicy, 'reject');
  s.close();
});

test('テナント設定の showBlueskyLogo が往復する', () => {
  const s = store();
  s.createTenant(makeTenantInput());

  // 既定では表示する。
  assert.equal(s.getTenant('my-event').settings.showBlueskyLogo, true);

  s.updateTenant('my-event', { settings: { showBlueskyLogo: false } });
  assert.equal(s.getTenant('my-event').settings.showBlueskyLogo, false);
  s.close();
});

test('画面モードと画像のメタが往復する', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(
    makeWall('my-event', {
      screen: { mode: 'break', breakNote: '14:30 再開', showImage: true },
      screenImage: { file: 'abc.png', mime: 'image/png', updatedAt: 42 },
    })
  );

  const [wall] = s.listWalls('my-event');
  assert.equal(wall.screen.mode, 'break');
  assert.equal(wall.screen.breakNote, '14:30 再開');
  // 保存値に無いキーは既定で埋まる。
  assert.equal(wall.screen.waitingHeadline, 'ハッシュタグはこちら');
  assert.deepEqual(wall.screenImage, { file: 'abc.png', mime: 'image/png', updatedAt: 42 });
  s.close();
});

test('画面モードを指定しないウォールは通常モードで始まる', () => {
  const s = store();
  s.createTenant(makeTenantInput());
  s.upsertWall(makeWall('my-event'));

  const [wall] = s.listWalls('my-event');
  assert.equal(wall.screen.mode, 'wall');
  assert.equal(wall.screenImage, null);
  s.close();
});
