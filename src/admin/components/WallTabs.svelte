<script>
  /**
   * 管理画面のコンソール。
   *
   * 左のナビは「テナント全体」→「ウォール」の入れ子。ウォールはテナントの子として
   * 開き、その配下に監視語・承認・会場モニターなどのセクションがぶら下がる。
   * 右にはいま選んでいるセクションだけを出す。
   */
  import { store, switchWall, createWall, MAX_WALLS } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';
  import TermEditor from './TermEditor.svelte';
  import WallPanel from './WallPanel.svelte';
  import SharedPanels from './SharedPanels.svelte';

  // 'tenant:<id>' か 'wall:<id>'、または 'add-wall'。
  let section = $state('tenant:status');
  let openWallId = $state('');

  const tenantSections = [
    { id: 'status', label: '状態', icon: 'fa-solid fa-gauge-high' },
    { id: 'event', label: 'イベント情報', icon: 'fa-solid fa-signature' },
    { id: 'delivery', label: 'モニターへの配信', icon: 'fa-solid fa-tower-broadcast' },
    { id: 'ingest', label: '受信と取り込み', icon: 'fa-solid fa-satellite-dish' },
    { id: 'moderation', label: 'モデレーション', icon: 'fa-solid fa-shield-halved' },
    { id: 'access', label: 'メンバーとセッション', icon: 'fa-solid fa-users' },
  ];

  const wallSections = [
    { id: 'terms', label: '監視語' },
    { id: 'moderation', label: '承認と除外' },
    { id: 'monitor', label: '会場モニター' },
    { id: 'manage', label: 'ウォール管理' },
    { id: 'ops', label: '承認待ち / 直近' },
  ];

  const currentWall = $derived(store.walls.find((w) => w.id === store.currentWallId) || store.walls[0]);
  const atLimit = $derived(store.walls.length >= MAX_WALLS);
  const connected = $derived(!!(store.state.jetstream && store.state.jetstream.connected));

  const tenantSection = $derived(section.startsWith('tenant:') ? section.slice('tenant:'.length) : '');
  const wallSection = $derived(section.startsWith('wall:') ? section.slice('wall:'.length) : '');
  const screenModeLabel = $derived.by(() => {
    const mode = (store.state.screen && store.state.screen.mode) || 'wall';
    if (mode === 'waiting') return '待機';
    if (mode === 'break') return '休憩';
    if (mode === 'ended') return '終演';
    return '';
  });

  // 起動直後はウォールが未取得なので、最初に届いた時点で選択中のウォールを開く。
  $effect(() => {
    if (!openWallId && store.currentWallId) openWallId = store.currentWallId;
  });

  function openWall(wall) {
    if (openWallId === wall.id) {
      openWallId = '';
      return;
    }
    openWallId = wall.id;
    if (wall.id !== store.currentWallId) switchWall(wall.id);
    if (!section.startsWith('wall:')) section = 'wall:terms';
  }

  function pickWallSection(wall, id) {
    if (wall.id !== store.currentWallId) switchWall(wall.id);
    openWallId = wall.id;
    section = 'wall:' + id;
  }

  function wallBadge(wall, id) {
    if (id === 'terms') return String((wall.terms || []).length);
    if (id === 'ops') return String(wall.pendingCount || 0);
    if (id === 'monitor' && wall.id === store.currentWallId) return screenModeLabel;
    return '';
  }

  // ---- ウォールの追加 ----
  let newNameInputEl = $state(null);
  let newWallTerms = $state([]);
  let creating = $state(false);
  let backfillSelectEl = $state(null);

  const presets = $derived(store.settings.backfillPresets || []);

  function presetLabel(minutes) {
    if (minutes % 1440 === 0) return minutes / 1440 + ' 日';
    if (minutes % 60 === 0) return minutes / 60 + ' 時間';
    return minutes + ' 分';
  }

  function addNewWallTerm(raw, isKeyword) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return false;
    const type = isKeyword ? 'keyword' : 'hashtag';
    const value = type === 'hashtag' ? trimmed.replace(/^[#＃]+/, '') : trimmed;
    if (!value) return false;
    if (type === 'keyword' && value.length < 2) return false;
    const duplicated = newWallTerms.some((t) => t.type === type && t.value.toLowerCase() === value.toLowerCase());
    if (duplicated) return false;
    newWallTerms = [...newWallTerms, { value, type, requireApproval: 'inherit' }];
    return true;
  }

  function removeNewWallTerm(term) {
    newWallTerms = newWallTerms.filter((t) => !(t.value === term.value && t.type === term.type));
  }

  function setNewWallTermApproval(term, requireApproval) {
    newWallTerms = newWallTerms.map((t) =>
      t.value === term.value && t.type === term.type ? { ...t, requireApproval } : t
    );
  }

  async function submitCreate() {
    creating = true;
    const name = (newNameInputEl && newNameInputEl.value) || '';
    const minutes = parseInt((backfillSelectEl && backfillSelectEl.value) || '0', 10);
    const ok = await createWall(name, newWallTerms, Number.isFinite(minutes) ? minutes : 0);
    creating = false;
    if (ok) {
      if (newNameInputEl) newNameInputEl.value = '';
      newWallTerms = [];
      section = 'wall:terms';
    }
  }
</script>

<div class="console">
  <!-- 左: テナント > ウォール の階層ナビ -->
  <nav class="console-nav" aria-label="設定">
    <p class="console-nav-group">テナント全体</p>
    {#each tenantSections as item (item.id)}
      <button
        type="button"
        class={'wall-nav-item' + (section === 'tenant:' + item.id ? ' is-active' : '')}
        aria-current={section === 'tenant:' + item.id ? 'page' : undefined}
        onclick={() => (section = 'tenant:' + item.id)}
      >
        <i class={item.icon + ' fa-fw'} aria-hidden="true"></i>
        <span class="wall-nav-label">{item.label}</span>
      </button>
    {/each}

    <div class="console-nav-head">
      <span class="console-nav-group">ウォール</span>
      <span class="console-nav-count">{store.walls.length} / {MAX_WALLS}</span>
    </div>

    {#each store.walls as w (w.id)}
      <button
        type="button"
        class={'wall-nav-item' + (openWallId === w.id && section.startsWith('wall:') ? ' is-active' : '')}
        aria-expanded={openWallId === w.id}
        onclick={() => openWall(w)}
      >
        <i class={'fa-solid fa-chevron-right fa-fw console-caret' + (openWallId === w.id ? ' is-open' : '')} aria-hidden="true"></i>
        <span class="wall-nav-label">{w.name}</span>
        {#if w.pendingCount > 0}
          <span class="wall-nav-badge wall-nav-badge-warn">{w.pendingCount}</span>
        {/if}
      </button>

      {#if openWallId === w.id}
        <div class="console-subnav">
          {#each wallSections as sec (sec.id)}
            <button
              type="button"
              class={'wall-nav-item wall-nav-sub' + (section === 'wall:' + sec.id && store.currentWallId === w.id ? ' is-active' : '')}
              aria-current={section === 'wall:' + sec.id && store.currentWallId === w.id ? 'page' : undefined}
              onclick={() => pickWallSection(w, sec.id)}
            >
              <span class="wall-nav-label">{sec.label}</span>
              {#if wallBadge(w, sec.id)}
                <span class={'wall-nav-badge' + (sec.id === 'ops' && w.pendingCount > 0 ? ' wall-nav-badge-warn' : '')}>
                  {wallBadge(w, sec.id)}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {/each}

    <button
      type="button"
      class={'wall-nav-item' + (section === 'add-wall' ? ' is-active' : '')}
      disabled={atLimit}
      onclick={() => (section = 'add-wall')}
    >
      <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i>
      <span class="wall-nav-label">ウォールを追加</span>
    </button>
  </nav>

  <!-- 右: 選択したセクション -->
  <div class="console-main">
    <div class="console-bar">
      <div class="console-bar-left">
        {#if section.startsWith('wall:') && currentWall}
          <i class="fa-solid fa-desktop fa-fw wall-bar-icon" aria-hidden="true"></i>
          <span class="console-bar-name">{currentWall.name}</span>
          <span class="wall-manage-id">{currentWall.id}</span>
        {:else}
          <i class="fa-solid fa-sliders fa-fw wall-bar-icon" aria-hidden="true"></i>
          <span class="console-bar-name">{store.settings.title || 'テナント設定'}</span>
          {#if store.tenantId}
            <span class="wall-manage-id">{store.tenantId}</span>
          {/if}
        {/if}
      </div>

      <div class="wall-bar-stats">
        <span class="wall-chip">
          <span class={'wall-chip-dot' + (connected ? ' is-on' : '')}></span>
          {connected ? '受信中' : '未接続'}
        </span>
        {#if screenModeLabel}
          <span class="wall-chip wall-chip-warn">{screenModeLabel}モード</span>
        {/if}
        <span class="wall-chip">
          <strong>{currentWall ? currentWall.postCount : 0}</strong>
          表示中
        </span>
        <span class={'wall-chip' + (currentWall && currentWall.pendingCount > 0 ? ' wall-chip-warn' : '')}>
          <strong>{currentWall ? currentWall.pendingCount : 0}</strong>
          承認待ち
        </span>
      </div>
    </div>

    <div class="console-section">
      {#if section === 'add-wall'}
        <header class="wall-section-head">
          <h2>ウォールを追加</h2>
          <p>会場モニター 1 画面分の単位です。作成後に承認や表示の設定を変えられます。</p>
        </header>

        <section class="panel">
          <div class="field">
            <label for="wall-new-name-input"><i class="fa-solid fa-signature fa-fw" aria-hidden="true"></i> ウォール名</label>
            <div class="field-row">
              <wa-input
                id="wall-new-name-input"
                bind:this={newNameInputEl}
                autocomplete="off"
                placeholder="ウォール名 (例: アート会場)"
                disabled={atLimit}
                use:enterKey={submitCreate}
              ></wa-input>
            </div>
          </div>
          <div class="field">
            <label for="wall-new-term-input"><i class="fa-solid fa-filter fa-fw" aria-hidden="true"></i> 監視語</label>
            <TermEditor
              terms={newWallTerms}
              onAdd={addNewWallTerm}
              onRemove={removeNewWallTerm}
              onApprovalChange={setNewWallTermApproval}
              disabled={atLimit}
              addButtonVariant="neutral"
              addLabel="監視語を追加"
              emptyMessage="監視語がまだありません。最低 1 つ必要です。"
            />
          </div>
          <div class="field">
            <label for="wall-new-backfill"><i class="fa-solid fa-clock-rotate-left fa-fw" aria-hidden="true"></i> 作成後に過去の投稿を取り込む</label>
            <div class="field-row">
              <wa-select id="wall-new-backfill" bind:this={backfillSelectEl} value="0" disabled={atLimit}>
                <wa-option value="0">取り込まない</wa-option>
                {#each presets as minutes (minutes)}
                  <wa-option value={String(minutes)}>過去 {presetLabel(minutes)}</wa-option>
                {/each}
              </wa-select>
            </div>
            <p class="field-note">候補は「受信と取り込み」で足せます。</p>
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
        </section>
      {:else if section.startsWith('wall:')}
        {#if currentWall}
          {#key currentWall.id + ':' + wallSection}
            <WallPanel wall={currentWall} section={wallSection} />
          {/key}
        {:else}
          <p class="empty-msg">ウォールがありません。</p>
        {/if}
      {:else}
        <SharedPanels section={tenantSection} />
      {/if}
    </div>
  </div>
</div>
