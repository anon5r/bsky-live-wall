<script>
  /**
   * ウォールのタブ。タブ自体がウォール一覧を兼ねる。
   *
   * wa-tab-group には既知のバグ回避が要る (applyActiveTab 参照)。
   * タブが挿入された直後は内部の shadow DOM (スロット参照) がまだ揃って
   * おらず、setActiveTab()/syncTabsAndPanels() を直接呼ぶと例外を投げる
   * ことがある。公式の宣言的 API である `active` プロパティの設定だけに
   * とどめ、反映されていなければ回数の上限を決めて再試行する。
   */
  import { store, switchWall, createWall, MAX_WALLS } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';
  import TermEditor from './TermEditor.svelte';
  import WallPanel from './WallPanel.svelte';

  let tabGroupEl = $state(null);
  let newNameInputEl = $state(null);
  // 「+ ウォールを追加」タブを開いている間は、3 秒ごとのポーリングによる
  // 再描画で選択中のウォールのタブへ強制的に戻さないようにする。
  let stayOnNewWallTab = $state(false);
  let newWallTerms = $state([]);
  let creating = $state(false);

  function wallPanelName(id) {
    return 'wall-' + id;
  }

  // wa-tab-group の `active` プロパティは公式の宣言的 API で、これを設定
  // するだけで内部の状態更新をコンポーネント自身に任せられる。
  // setActiveTab()/syncTabsAndPanels() を直接呼ぶ手段は、タブが挿入された
  // 直後で内部の shadow DOM (スロット参照) がまだ揃っていない場合に
  // 例外を投げることがあり、しかもその例外がコンポーネント自身の
  // slotchange ハンドラ経由でも非同期に再発生しうるため、無限リトライに
  // つながりかねない。ここでは安全なプロパティ設定のみを使い、反映が
  // まだの場合に限り、回数の上限を決めて次のフレームで再試行する。
  function applyActiveTab(activeName, attemptsLeft = 5) {
    if (!tabGroupEl) return;
    try {
      tabGroupEl.active = activeName;
    } catch {
      // 無視。次の試行に委ねる。
    }
    if (attemptsLeft > 0) {
      requestAnimationFrame(() => {
        if (tabGroupEl && tabGroupEl.active !== activeName) {
          applyActiveTab(activeName, attemptsLeft - 1);
        }
      });
    }
  }

  $effect(() => {
    // store.walls / store.currentWallId の変化を追跡する。
    const activeId = store.currentWallId;
    const walls = store.walls;
    if (!tabGroupEl || !activeId || stayOnNewWallTab) return;
    const activeName = wallPanelName(activeId);
    if (tabGroupEl.active !== activeName) {
      applyActiveTab(activeName);
    }
  });

  function onTabShow(evt) {
    const name = evt.detail && evt.detail.name;
    if (!name) return;
    if (name === 'wall-new') {
      stayOnNewWallTab = true;
      return;
    }
    stayOnNewWallTab = false;
    const id = name.slice('wall-'.length);
    switchWall(id);
  }

  const atLimit = $derived(store.walls.length >= MAX_WALLS);

  function addNewWallTerm(raw, isKeyword) {
    const trimmed = (raw || '').trim();
    if (!trimmed) {
      return false;
    }
    const type = isKeyword ? 'keyword' : 'hashtag';
    const value = type === 'hashtag' ? trimmed.replace(/^[#＃]+/, '') : trimmed;
    if (!value) return false;
    if (type === 'keyword' && value.length < 2) return false;
    const duplicated = newWallTerms.some((t) => t.type === type && t.value.toLowerCase() === value.toLowerCase());
    if (duplicated) return false;
    newWallTerms = [...newWallTerms, { value, type }];
    return true;
  }

  function removeNewWallTerm(term) {
    newWallTerms = newWallTerms.filter((t) => !(t.value === term.value && t.type === term.type));
  }

  async function submitCreate() {
    creating = true;
    const name = (newNameInputEl && newNameInputEl.value) || '';
    const ok = await createWall(name, newWallTerms);
    creating = false;
    if (ok) {
      if (newNameInputEl) newNameInputEl.value = '';
      newWallTerms = [];
      stayOnNewWallTab = false;
    }
  }
</script>

<section class="panel panel-full panel-walltabs">
  <h2 class="panel-title"><i class="fa-solid fa-object-group fa-fw" aria-hidden="true"></i> ウォール</h2>

  <wa-tab-group bind:this={tabGroupEl} activation="auto" onwa-tab-show={onTabShow}>
    {#each store.walls as w (w.id)}
      <wa-tab panel={wallPanelName(w.id)}>
        <span>{w.name}</span>
        <wa-badge variant={w.pendingCount > 0 ? 'warning' : 'neutral'}>
          {w.postCount} 件{w.pendingCount > 0 ? ' / 承認待ち ' + w.pendingCount : ''}
        </wa-badge>
      </wa-tab>
    {/each}
    <wa-tab panel="wall-new"><i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> ウォールを追加</wa-tab>

    {#each store.walls as w (w.id)}
      <wa-tab-panel name={wallPanelName(w.id)}>
        {#if w.id === store.currentWallId}
          <WallPanel wall={w} />
        {/if}
      </wa-tab-panel>
    {/each}

    <wa-tab-panel name="wall-new">
      <div class="field">
        <label for="wall-new-name-input"><i class="fa-solid fa-signature fa-fw" aria-hidden="true"></i> ウォール名</label>
        <div class="field-row">
          <wa-input bind:this={newNameInputEl} autocomplete="off" placeholder="ウォール名 (例: アート会場)" disabled={atLimit} use:enterKey={submitCreate}></wa-input>
        </div>
      </div>
      <div class="field">
        <label for="wall-new-term-input"><i class="fa-solid fa-filter fa-fw" aria-hidden="true"></i> 監視語</label>
        <TermEditor
          terms={newWallTerms}
          onAdd={addNewWallTerm}
          onRemove={removeNewWallTerm}
          disabled={atLimit}
          addButtonVariant="neutral"
          addLabel="監視語を追加"
          emptyMessage="監視語がまだありません。最低 1 つ必要です。"
        />
      </div>
      <div class="field-row">
        <wa-button variant="brand" disabled={atLimit || creating} onclick={submitCreate}>
          <i class="fa-solid fa-display fa-fw" aria-hidden="true"></i> このウォールを作成
        </wa-button>
      </div>
      {#if atLimit}
        <wa-callout variant="warning">
          <i class="fa-solid fa-triangle-exclamation fa-fw" aria-hidden="true"></i>
          ウォールは {MAX_WALLS} 個まで作成できます。上限に達しているため、新規作成できません。
        </wa-callout>
      {/if}
    </wa-tab-panel>
  </wa-tab-group>
</section>
