import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInvitedActor } from '../dist/server/routes/oauth.js';
import { setSystemAdminDids } from '../dist/server/permission.js';

/** listForDid / listMembers だけを持つ最小の registry スタブ。 */
function registryWith(members) {
  const tenant = {
    listMembers: () => members,
  };
  return {
    listForDid: (did) => (members.some((m) => m.did === did) ? [tenant] : []),
  };
}

test('管理画面から招待されたメンバーはログインを許可する', () => {
  setSystemAdminDids(new Set());
  const registry = registryWith([
    { did: 'did:plc:moderator', handle: 'midori.bsky.social', role: 'moderator' },
  ]);

  assert.deepEqual(findInvitedActor('did:plc:moderator', registry), {
    did: 'did:plc:moderator',
    handle: 'midori.bsky.social',
  });
});

test('どのテナントのメンバーでもない DID は許可しない', () => {
  setSystemAdminDids(new Set());
  const registry = registryWith([{ did: 'did:plc:owner', handle: 'anon5r.com', role: 'owner' }]);

  assert.equal(findInvitedActor('did:plc:stranger', registry), undefined);
});

test('システム管理者はメンバー表に無くても許可する', () => {
  setSystemAdminDids(new Set(['did:plc:sysadmin']));
  const registry = registryWith([]);

  assert.deepEqual(findInvitedActor('did:plc:sysadmin', registry), {
    did: 'did:plc:sysadmin',
    handle: 'did:plc:sysadmin',
  });
  setSystemAdminDids(new Set());
});

test('registry が無い (single モード) 場合は許可しない', () => {
  setSystemAdminDids(new Set());
  assert.equal(findInvitedActor('did:plc:moderator', undefined), undefined);
});
