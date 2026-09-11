<script>
  import { onMount } from 'svelte';
  import {
    store,
    init,
    logout,
    toggleTheme,
    showTenantSelect,
    showSystemAdmin,
    wallUrl,
  } from './lib/store.svelte.js';
  import Login from './components/Login.svelte';
  import WallTabs from './components/WallTabs.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import Toast from './components/Toast.svelte';
  import TenantSelect from './components/TenantSelect.svelte';
  import SystemAdmin from './components/SystemAdmin.svelte';
  import Forbidden from './components/Forbidden.svelte';

  onMount(() => {
    init();
  });

  function openWall() {
    window.open(wallUrl(store.currentWallId), '_blank', 'noopener');
  }
</script>

<Toast />

{#if store.page === 'app'}
  <div class="pause-banner" hidden={!store.state.paused}>
    モニターへの配信を停止中 (全ウォール共通) - 受信は続いていますが、会場モニターには新規表示されません
  </div>

  <div class="app">
    <header class="app-header">
      <div class="app-header-title">
        <h1>Bluesky Live Wall <span class="app-header-sub">管理画面</span></h1>
      </div>
      <div class="app-header-actions">
        {#if store.mode === 'multi'}
          <wa-button variant="neutral" appearance="plain" onclick={showTenantSelect}>
            <i class="fa-solid fa-list fa-fw" aria-hidden="true"></i> テナント一覧
          </wa-button>
          {#if store.isSystemAdmin}
            <wa-button variant="neutral" appearance="plain" onclick={showSystemAdmin}>
              <i class="fa-solid fa-toolbox fa-fw" aria-hidden="true"></i> システム管理
            </wa-button>
          {/if}
        {/if}
        <wa-button variant="neutral" appearance="outlined" onclick={openWall}>
          <i class="fa-solid fa-display fa-fw" aria-hidden="true"></i> 会場モニターを開く
        </wa-button>
        <wa-button variant="neutral" appearance="plain" title="テーマ切替" onclick={toggleTheme}>
          <i class={(store.theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun') + ' fa-fw'} aria-hidden="true"></i> テーマ
        </wa-button>
        <wa-button variant="neutral" appearance="plain" onclick={logout}>
          <i class="fa-solid fa-right-from-bracket fa-fw" aria-hidden="true"></i> ログアウト
        </wa-button>
      </div>
    </header>

    <main class="console-main-area">
      <WallTabs />
    </main>
  </div>
{:else if store.page === 'tenant-select'}
  <TenantSelect />
{:else if store.page === 'system-admin'}
  <SystemAdmin />
{:else if store.page === 'forbidden'}
  <Forbidden />
{:else}
  <Login />
{/if}

<ConfirmDialog />
