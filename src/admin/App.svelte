<script>
  import { onMount } from 'svelte';
  import { store, init, logout, toggleTheme } from './lib/store.svelte.js';
  import Login from './components/Login.svelte';
  import SharedPanels from './components/SharedPanels.svelte';
  import WallTabs from './components/WallTabs.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import Toast from './components/Toast.svelte';

  onMount(() => {
    init();
  });

  function openWall() {
    const path = store.currentWallId ? '/wall/' + encodeURIComponent(store.currentWallId) : '/wall';
    window.open(path, '_blank', 'noopener');
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

    <main class="main-grid">
      <SharedPanels />
      <WallTabs />
    </main>
  </div>
{:else}
  <Login />
{/if}

<ConfirmDialog />
