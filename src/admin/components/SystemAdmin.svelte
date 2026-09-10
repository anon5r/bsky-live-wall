<script>
  /**
   * システム管理画面。multi モードの isSystemAdmin だけが到達できる
   * (store 側で経路を絞っている)。別ページは作らず、/admin の中の
   * 画面切り替えとして実装する。
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    store,
    showTenantSelect,
    logout,
    loadSystemAudit,
    createSystemTenant,
    requestDeleteSystemTenant,
    switchSystemJetstream,
    openTenant,
    startSystemPolling,
    stopSystemPolling,
  } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';

  onMount(() => {
    startSystemPolling();
    loadSystemAudit();
  });
  onDestroy(() => {
    stopSystemPolling();
  });

  const overview = $derived(store.systemOverview || {});
  const jetstream = $derived(overview.jetstream || {});

  let idInputEl = $state(null);
  let nameInputEl = $state(null);
  let ownerInputEl = $state(null);
  let creating = $state(false);

  async function onCreate() {
    creating = true;
    const id = (idInputEl && idInputEl.value) || '';
    const name = (nameInputEl && nameInputEl.value) || '';
    const owner = (ownerInputEl && ownerInputEl.value) || '';
    const ok = await createSystemTenant(id, name, owner);
    creating = false;
    if (ok) {
      if (idInputEl) idInputEl.value = '';
      if (nameInputEl) nameInputEl.value = '';
      if (ownerInputEl) ownerInputEl.value = '';
    }
  }

  let jetstreamSelectEl = $state(null);
  $effect(() => {
    const current = jetstream.host || '';
    if (jetstreamSelectEl && current && document.activeElement !== jetstreamSelectEl) {
      jetstreamSelectEl.value = current;
    }
  });

  function onJetstreamSwitch() {
    const host = jetstreamSelectEl && jetstreamSelectEl.value;
    switchSystemJetstream(host);
  }

  function formatUptimeMs(ms) {
    if (!ms) return '-';
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return h + ':' + pad(m) + ':' + pad(s);
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString('ja-JP');
    } catch {
      return '-';
    }
  }
</script>

<div class="app">
  <header class="app-header">
    <div class="app-header-title">
      <h1>Bluesky Live Wall <span class="app-header-sub">システム管理</span></h1>
    </div>
    <div class="app-header-actions">
      <wa-button variant="neutral" appearance="outlined" onclick={showTenantSelect}>
        <i class="fa-solid fa-list fa-fw" aria-hidden="true"></i> テナント一覧へ
      </wa-button>
      <wa-button variant="neutral" appearance="plain" onclick={logout}>
        <i class="fa-solid fa-right-from-bracket fa-fw" aria-hidden="true"></i> ログアウト
      </wa-button>
    </div>
  </header>

  <main class="main-grid">
    <!-- 全体状況 -->
    <section class="panel panel-full">
      <h2 class="panel-title"><i class="fa-solid fa-gauge-high fa-fw" aria-hidden="true"></i> 全体状況</h2>
      <div class="status-grid">
        <div class="status-item">
          <span class="status-label">Jetstream</span>
          <wa-badge variant={jetstream.connected ? 'success' : 'danger'}>{jetstream.connected ? '接続中' : '切断'}</wa-badge>
        </div>
        <div class="status-item">
          <span class="status-label">接続先ホスト</span>
          <span class="status-value">{jetstream.host || '-'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">テナント数</span>
          <span class="status-value">{overview.tenants != null ? overview.tenants : '-'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">ウォール数</span>
          <span class="status-value">{overview.walls != null ? overview.walls : '-'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">SSE 接続数</span>
          <span class="status-value">{overview.sseClients != null ? overview.sseClients : '-'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">セッション数</span>
          <span class="status-value">{overview.sessions != null ? overview.sessions : '-'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">稼働時間</span>
          <span class="status-value">{formatUptimeMs(overview.uptime)}</span>
        </div>
      </div>
    </section>

    <!-- 接続先の切り替え -->
    <section class="panel">
      <h2 class="panel-title"><i class="fa-solid fa-satellite-dish fa-fw" aria-hidden="true"></i> Jetstream 接続先</h2>
      <div class="field-row">
        <wa-select bind:this={jetstreamSelectEl}>
          {#each overview.jetstreamHosts || [] as host (host)}
            <wa-option value={host}>{host}</wa-option>
          {/each}
        </wa-select>
        <wa-button variant="neutral" appearance="outlined" onclick={onJetstreamSwitch}>
          <i class="fa-solid fa-arrows-rotate fa-fw" aria-hidden="true"></i> 切り替え
        </wa-button>
      </div>
      <p class="field-note">全テナントが 1 本の接続を共有しています。切り替えは全テナントに影響します。</p>
    </section>

    <!-- テナント作成 -->
    <section class="panel">
      <h2 class="panel-title"><i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> テナントを作成</h2>
      <div class="field">
        <label for="system-tenant-id"><i class="fa-solid fa-hashtag fa-fw" aria-hidden="true"></i> テナント ID</label>
        <wa-input id="system-tenant-id" bind:this={idInputEl} autocomplete="off" placeholder="acme (英数字と _- のみ)" use:enterKey={onCreate}></wa-input>
      </div>
      <div class="field">
        <label for="system-tenant-name"><i class="fa-solid fa-signature fa-fw" aria-hidden="true"></i> 名前</label>
        <wa-input id="system-tenant-name" bind:this={nameInputEl} autocomplete="off" placeholder="Acme Conf" use:enterKey={onCreate}></wa-input>
      </div>
      <div class="field">
        <label for="system-tenant-owner"><i class="fa-solid fa-user fa-fw" aria-hidden="true"></i> オーナー (ハンドルまたは DID)</label>
        <wa-input id="system-tenant-owner" bind:this={ownerInputEl} autocomplete="off" placeholder="alice.bsky.social" use:enterKey={onCreate}></wa-input>
      </div>
      <div class="field-row">
        <wa-button variant="brand" disabled={creating} onclick={onCreate}>
          <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> 作成
        </wa-button>
      </div>
    </section>

    <!-- テナント一覧 -->
    <section class="panel panel-full">
      <h2 class="panel-title">
        <i class="fa-solid fa-building fa-fw" aria-hidden="true"></i> 全テナント
        <span class="panel-count">{(store.systemTenants || []).length}</span>
      </h2>
      {#if (store.systemTenants || []).length > 0}
        <ul class="actor-list">
          {#each store.systemTenants as t (t.id)}
            <li class="actor-item actor-item-wrap">
              <div>
                <div class="actor-name">{t.name} <span class="wall-manage-id">({t.id})</span></div>
                <div class="field-note list-meta">
                  <span>メンバー {t.memberCount} 人</span>
                  <span>ウォール {t.wallCount} 件</span>
                </div>
              </div>
              <div class="system-tenant-row">
                <button type="button" class="btn btn-neutral btn-small" onclick={() => openTenant(t.id)}>
                  <i class="fa-solid fa-arrow-right fa-fw" aria-hidden="true"></i> 開く
                </button>
                <button type="button" class="btn btn-danger btn-small" onclick={() => requestDeleteSystemTenant(t)}>
                  <i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i> 削除
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty-msg">テナントがありません。</p>
      {/if}
    </section>

    <!-- 監査ログ -->
    <section class="panel panel-full">
      <h2 class="panel-title">
        <i class="fa-solid fa-scroll fa-fw" aria-hidden="true"></i> 監査ログ (全テナント)
        <span class="panel-count">{(store.systemAudit || []).length}</span>
      </h2>
      <div class="field-row">
        <wa-button variant="neutral" appearance="outlined" onclick={loadSystemAudit}>
          <i class="fa-solid fa-arrows-rotate fa-fw" aria-hidden="true"></i> 再読み込み
        </wa-button>
      </div>
      {#if (store.systemAudit || []).length > 0}
        <ul class="actor-list">
          {#each store.systemAudit as entry, i (i)}
            <li class="actor-item actor-item-wrap">
              <div>
                <div class="actor-name">{entry.action}</div>
                <div class="field-note list-meta">
                  <span>{formatTime(entry.at)}</span>
                  <span>実行者: {entry.actor}</span>
                  <span>IP: {entry.ip}</span>
                </div>
                <div class="field-note">{entry.detail}</div>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty-msg">監査ログはまだありません。</p>
      {/if}
    </section>
  </main>
</div>
