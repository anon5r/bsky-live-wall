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
</script>

<section class="panel panel-full">
  <h2 class="panel-title">
    <i class="fa-solid fa-users fa-fw" aria-hidden="true"></i> メンバー管理
    <span class="panel-count">{(store.members || []).length}</span>
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>

  {#if (store.members || []).length > 0}
    <ul class="actor-list">
      {#each store.members as m (m.did)}
        <li class="actor-item actor-item-wrap">
          <div>
            <div class="actor-name">{m.handle}</div>
            <div class="field-note list-meta">
              <span>{m.did}</span>
              <span>追加: {formatAddedAt(m.addedAt)}</span>
            </div>
          </div>
          <div class="field-row member-row-actions">
            <wa-select value={m.role} onchange={(evt) => onRoleChange(m, evt)}>
              <wa-option value="owner">オーナー</wa-option>
              <wa-option value="moderator">モデレーター</wa-option>
            </wa-select>
            <button type="button" class="btn btn-danger btn-small" onclick={() => requestRemoveMember(m)}>
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
    <div class="field-row">
      <wa-input id="member-actor-input" bind:this={actorInputEl} autocomplete="off" placeholder="ハンドルまたは DID" use:enterKey={onAdd}></wa-input>
      <wa-select id="member-role-select" bind:this={roleSelectEl} value="moderator">
        <wa-option value="moderator">モデレーター</wa-option>
        <wa-option value="owner">オーナー</wa-option>
      </wa-select>
      <wa-button variant="brand" disabled={adding} onclick={onAdd}>
        <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> 追加
      </wa-button>
    </div>
    <p class="field-note">
      オーナーは設定変更を含むすべての操作、モデレーターは日々の運用操作のみ行えます。
      オーナーが 0 人になる変更・削除はサーバー側で拒否されます。
    </p>
  </div>
</section>
