<script>
  /**
   * テナントのメンバー管理 (owner とシステム管理者のみ表示。SharedPanels から使う)。
   * single モードには「メンバー」という概念が無いため、呼び出し側で multi のみに絞る。
   */
  import { onMount } from 'svelte';
  import { store, loadMembers, addMember, updateMemberRole, requestRemoveMember } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';

  onMount(() => {
    loadMembers();
  });

  let actorInputEl = $state(null);
  let roleSelectEl = $state(null);
  let adding = $state(false);

  async function onAdd() {
    adding = true;
    const actor = (actorInputEl && actorInputEl.value) || '';
    const role = (roleSelectEl && roleSelectEl.value) || 'moderator';
    const ok = await addMember(actor, role);
    adding = false;
    if (ok && actorInputEl) actorInputEl.value = '';
  }

  function formatAddedAt(ts) {
    if (!ts) return '-';
    try {
      return new Date(ts).toLocaleString('ja-JP');
    } catch {
      return '-';
    }
  }

  // wa-select は素の <select> と同様に change イベントの target から現在値を読める。
  function onRoleChange(member, evt) {
    const next = evt.target && evt.target.value;
    if (!next || next === member.role) return;
    updateMemberRole(member.did, next);
  }

  function roleLabel(role) {
    return role === 'owner' ? 'オーナー' : 'モデレーター';
  }

  // 役割が一目で分かるようにアイコンを変える (アバター画像は持っていないため)。
  function roleIcon(role) {
    return role === 'owner' ? 'fa-solid fa-user-shield' : 'fa-solid fa-user';
  }

  /** ハンドルの先頭 1 文字。アバター代わりの頭文字表示に使う。 */
  function initialOf(handle) {
    return (handle || '?').replace(/^@/, '').charAt(0).toUpperCase();
  }
</script>

<section class="panel panel-full">
  <h2 class="panel-title">
    <i class="fa-solid fa-users fa-fw" aria-hidden="true"></i> メンバー管理
    <span class="panel-count">{(store.members || []).length}</span>
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>

  {#if (store.members || []).length > 0}
    <ul class="member-list">
      {#each store.members as m (m.did)}
        <li class="member-item">
          <span
            class={'member-avatar member-avatar-' + m.role}
            title={roleLabel(m.role)}
            aria-label={roleLabel(m.role)}
          >
            <span class="member-avatar-initial" aria-hidden="true">{initialOf(m.handle)}</span>
            <i class={roleIcon(m.role) + ' member-avatar-badge'} aria-hidden="true"></i>
          </span>

          <div class="member-main">
            <div class="member-handle">{m.handle}</div>
            <div class="member-meta">
              <span class="member-did" title={m.did}>{m.did}</span>
              <span class="member-added">追加: {formatAddedAt(m.addedAt)}</span>
            </div>
          </div>

          <div class="member-actions">
            <wa-select
              class="member-role-select"
              size="s"
              value={m.role}
              aria-label={m.handle + ' の役割'}
              onchange={(evt) => onRoleChange(m, evt)}
            >
              <wa-option value="owner">オーナー</wa-option>
              <wa-option value="moderator">モデレーター</wa-option>
            </wa-select>
            <button
              type="button"
              class="btn btn-danger btn-small"
              aria-label={m.handle + ' を削除'}
              onclick={() => requestRemoveMember(m)}
            >
              <i class="fa-solid fa-user-minus fa-fw" aria-hidden="true"></i> 削除
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty-msg">メンバーがいません。</p>
  {/if}

  <div class="field">
    <label for="member-actor-input"><i class="fa-solid fa-user-plus fa-fw" aria-hidden="true"></i> メンバーを追加</label>
    <div class="field-row member-add-row">
      <wa-input
        id="member-actor-input"
        bind:this={actorInputEl}
        autocomplete="off"
        placeholder="ハンドルまたは DID"
        aria-label="追加するメンバーのハンドルまたは DID"
        use:enterKey={onAdd}
      ></wa-input>
      <wa-select
        id="member-role-select"
        class="member-role-select"
        bind:this={roleSelectEl}
        value="moderator"
        aria-label="追加するメンバーの役割"
      >
        <wa-option value="moderator">モデレーター</wa-option>
        <wa-option value="owner">オーナー</wa-option>
      </wa-select>
      <wa-button variant="brand" disabled={adding} onclick={onAdd}>
        <i class="fa-solid fa-user-plus fa-fw" aria-hidden="true"></i> 追加
      </wa-button>
    </div>
    <p class="field-note">
      オーナーは設定変更を含むすべての操作、モデレーターは日々の運用操作のみ行えます。
      オーナーが 0 人になる変更・削除はサーバー側で拒否されます。
    </p>
  </div>
</section>
