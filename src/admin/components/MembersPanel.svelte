<script>
  /**
   * テナントのメンバー管理 (owner とシステム管理者のみ表示。SharedPanels から使う)。
   * single モードには「メンバー」という概念が無いため、呼び出し側で multi のみに絞る。
   */
  import { onMount } from 'svelte';
  import {
    store,
    loadMembers,
    addMember,
    updateMemberRole,
    requestRemoveMember,
    searchActors,
  } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';
  import ActorAvatar from './ActorAvatar.svelte';

  onMount(() => {
    loadMembers();
  });

  let actorInputEl = $state(null);
  let roleSelectEl = $state(null);
  let adding = $state(false);

  // 入力候補。ハンドルの打ち間違いをその場で潰せるよう、Bluesky から引いて出す。
  let suggestions = $state([]);
  let searching = $state(false);
  let searched = $state('');
  let suggestTimer = null;

  function onActorInput() {
    const q = ((actorInputEl && actorInputEl.value) || '').trim();
    if (suggestTimer) clearTimeout(suggestTimer);
    // DID をそのまま貼った場合は候補を出さない (検索の対象にならない)。
    if (q.length < 2 || q.startsWith('did:')) {
      suggestions = [];
      searched = '';
      return;
    }
    // 打鍵ごとに投げると AppView を叩きすぎるので少し待つ。
    suggestTimer = setTimeout(async () => {
      searching = true;
      const found = await searchActors(q);
      searching = false;
      searched = q;
      suggestions = found;
    }, 250);
  }

  function pickSuggestion(actor) {
    if (actorInputEl) actorInputEl.value = actor.handle;
    suggestions = [];
    searched = '';
  }

  function clearSuggestions() {
    if (suggestTimer) clearTimeout(suggestTimer);
    suggestions = [];
    searched = '';
  }

  async function onAdd() {
    adding = true;
    const actor = (actorInputEl && actorInputEl.value) || '';
    const role = (roleSelectEl && roleSelectEl.value) || 'moderator';
    const ok = await addMember(actor, role);
    adding = false;
    if (ok && actorInputEl) actorInputEl.value = '';
    if (ok) clearSuggestions();
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

  // 役割はアバターの右下に小さく重ねるバッジで示す。
  function roleIcon(role) {
    return role === 'owner' ? 'fa-solid fa-user-shield' : 'fa-solid fa-user';
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
            <ActorAvatar avatar={m.avatar || ''} handle={m.handle} displayName={m.displayName || ''} size={40} />
            <i class={roleIcon(m.role) + ' member-avatar-badge'} aria-hidden="true"></i>
          </span>

          <div class="member-main">
            <div class="member-handle">
              {m.displayName || m.handle}
              {#if m.displayName}<span class="member-sub-handle">@{m.handle}</span>{/if}
            </div>
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
        aria-describedby="member-actor-suggest"
        oninput={onActorInput}
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
    <div class="actor-suggest" id="member-actor-suggest" aria-live="polite">
      {#if searching}
        <p class="actor-suggest-empty"><i class="fa-solid fa-spinner fa-spin fa-fw" aria-hidden="true"></i> 候補を探しています…</p>
      {:else if suggestions.length > 0}
        <ul class="actor-suggest-list">
          {#each suggestions as actor (actor.did)}
            <li>
              <button type="button" class="actor-suggest-item" onclick={() => pickSuggestion(actor)}>
                <ActorAvatar avatar={actor.avatar || ''} handle={actor.handle} displayName={actor.displayName || ''} size={28} />
                <span class="actor-suggest-main">
                  <span class="actor-suggest-name">{actor.displayName || actor.handle}</span>
                  <span class="actor-suggest-handle">@{actor.handle}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if searched !== ''}
        <p class="actor-suggest-empty">「{searched}」に一致するアカウントが見つかりません。ハンドルを確認してください。</p>
      {/if}
    </div>
    <p class="field-note">
      オーナーは設定変更を含むすべての操作、モデレーターは日々の運用操作のみ行えます。
      オーナーが 0 人になる変更・削除はサーバー側で拒否されます。
    </p>
  </div>
</section>
