<script>
  /**
   * 選択中のウォール単位の内容。
   * 監視対象 / 承認待ち / 直近の投稿 / このウォールの操作。
   */
  import { store, addTerm, requestRemoveTerm, requestDeleteWall, renameWall, clearAll } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';
  import TermEditor from './TermEditor.svelte';
  import PostList from './PostList.svelte';
  import InlineConfirmButton from './InlineConfirmButton.svelte';

  let { wall } = $props();

  const wallName = $derived(store.state.wallName || '-');
  const showPending = $derived(store.state.moderationMode === 'approve' || (store.pending || []).length > 0);

  let renaming = $state(false);
  let renameInputEl = $state(null);

  function startRename() {
    renaming = true;
  }

  function cancelRename() {
    renaming = false;
  }

  async function submitRename() {
    const value = (renameInputEl && renameInputEl.value) || '';
    const ok = await renameWall(wall, value);
    if (ok) renaming = false;
  }

  function onRenameSubmit(evt) {
    evt.preventDefault();
    submitRename();
  }

  $effect(() => {
    if (renaming && renameInputEl) {
      // レンダリングと同じフラッシュ内で行うとタイミング次第で内部要素が
      // まだ用意できておらず例外になることがあるため、次のフレームに回す。
      const el = renameInputEl;
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        try {
          el.focus();
          el.select();
        } catch {
          // フォーカスできなくても致命的ではない
        }
      });
    }
  });
</script>

<div class="wall-panel-content">
  <!-- 監視対象 -->
  <section class="panel">
    <h2 class="panel-title">
      <i class="fa-solid fa-binoculars fa-fw" aria-hidden="true"></i> 監視対象
      <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール「{wallName}」</span>
    </h2>
    <div class="field">
      <label for="term-input"><i class="fa-solid fa-filter fa-fw" aria-hidden="true"></i> 監視対象の追加</label>
      <TermEditor
        terms={store.state.terms || []}
        onAdd={(raw, isKeyword) => addTerm(raw, isKeyword)}
        onRemove={(term) => requestRemoveTerm(term)}
        showKeywordWarning={true}
        addLabel="追加"
      />
      <p class="field-note">
        既定はハッシュタグです。チェックを入れると本文中の任意の文字列に一致します。
        合計 20 件まで。<strong>この設定は選択中のウォールにのみ適用されます。</strong>
      </p>
    </div>
  </section>

  <!-- 承認待ちリスト -->
  {#if showPending}
    <section class="panel">
      <h2 class="panel-title">
        <i class="fa-solid fa-circle-check fa-fw" aria-hidden="true"></i> 承認待ち
        <span class="panel-count">{(store.pending || []).length}</span>
        <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール「{wallName}」</span>
      </h2>
      <PostList
        posts={store.pending || []}
        emptyMessage="承認待ちの投稿はありません。"
        showApprove={true}
        showHide={true}
        showBlock={true}
        rejectLabel={true}
      />
    </section>
  {/if}

  <!-- 直近投稿リスト -->
  <section class="panel">
    <h2 class="panel-title">
      <i class="fa-solid fa-comments fa-fw" aria-hidden="true"></i> 直近の投稿
      <span class="panel-count">{(store.recent || []).length}</span>
      <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール「{wallName}」</span>
    </h2>
    <PostList posts={store.recent || []} emptyMessage="まだ投稿がありません。" showHide={true} showBlock={true} />
  </section>

  <!-- このウォールの操作 -->
  <section class="panel">
    <h2 class="panel-title">
      <i class="fa-solid fa-sliders fa-fw" aria-hidden="true"></i> このウォールの操作
      <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール「{wallName}」</span>
    </h2>
    <div class="control-row">
      <span class="control-label"><i class="fa-solid fa-broom fa-fw" aria-hidden="true"></i> 表示中の全消去</span>
      <InlineConfirmButton label="全消去" icon="fa-solid fa-broom" className="btn btn-danger" onConfirm={clearAll} />
    </div>
    <div class="control-row">
      <span class="control-label"><i class="fa-solid fa-pen fa-fw" aria-hidden="true"></i> 名前</span>
      <div class="wall-rename-slot">
        {#if renaming}
          <form class="wall-rename-form" onsubmit={onRenameSubmit}>
            <wa-input bind:this={renameInputEl} size="s" aria-label="ウォール名" value={wall.name} use:enterKey={submitRename}></wa-input>
            <wa-button type="submit" size="s" variant="brand">
              <i class="fa-solid fa-check fa-fw" aria-hidden="true"></i>
            </wa-button>
            <wa-button type="button" size="s" appearance="plain" variant="neutral" onclick={cancelRename}>
              <i class="fa-solid fa-xmark fa-fw" aria-hidden="true"></i>
            </wa-button>
          </form>
        {:else}
          <span>{wall.name}</span>
          {#if wall.isDefault}
            <span class="wall-default-badge">既定</span>
          {/if}
          <wa-button size="s" appearance="outlined" variant="neutral" onclick={startRename}>
            <i class="fa-solid fa-pen fa-fw" aria-hidden="true"></i> 改名
          </wa-button>
        {/if}
      </div>
    </div>
    {#if !wall.isDefault}
      <div class="control-row">
        <span class="control-label"><i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i> このウォールを削除</span>
        <wa-button variant="danger" onclick={() => requestDeleteWall(wall)}>
          <i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i> 削除
        </wa-button>
      </div>
    {/if}
    <div class="control-row">
      <span class="control-label"><i class="fa-solid fa-up-right-from-square fa-fw" aria-hidden="true"></i> 会場モニター</span>
      <a class="btn btn-neutral btn-small" href={'/wall/' + encodeURIComponent(wall.id)} target="_blank" rel="noopener">
        <i class="fa-solid fa-up-right-from-square fa-fw" aria-hidden="true"></i> このウォールを開く
      </a>
    </div>
    <div class="control-row">
      <span class="control-label">ウォール ID</span>
      <span class="wall-manage-id">{wall.id}</span>
    </div>
  </section>
</div>
