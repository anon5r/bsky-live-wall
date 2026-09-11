<script>
  /**
   * multi モードの入口。/admin (テナント未指定) で表示する。
   * ログイン中のアカウントが操作できるテナントを一覧し、選ぶと
   * /e/<tenant>/admin へ遷移する (リロード・ブックマークで同じテナントに戻れる)。
   */
  import { store, openTenant, showSystemAdmin, logout } from '../lib/store.svelte.js';

  function roleLabel(role) {
    if (role === 'system') return 'システム管理者';
    if (role === 'owner') return 'オーナー';
    return 'モデレーター';
  }
</script>

<div class="app">
  <header class="app-header">
    <div class="app-header-title">
      <h1>Bluesky Live Wall <span class="app-header-sub">テナントを選択</span></h1>
    </div>
    <div class="app-header-actions">
      {#if store.isSystemAdmin}
        <wa-button variant="brand" appearance="outlined" onclick={showSystemAdmin}>
          <i class="fa-solid fa-toolbox fa-fw" aria-hidden="true"></i> システム管理
        </wa-button>
      {/if}
      <wa-button variant="neutral" appearance="plain" onclick={logout}>
        <i class="fa-solid fa-right-from-bracket fa-fw" aria-hidden="true"></i> ログアウト
      </wa-button>
    </div>
  </header>

  <main class="tenant-select-main">
    <section class="panel panel-full">
      <h2 class="panel-title"><i class="fa-solid fa-building fa-fw" aria-hidden="true"></i> 操作できるテナント</h2>

      {#if (store.tenants || []).length === 0}
        <p class="empty-msg">
          操作できるテナントがありません。
          {#if store.isSystemAdmin}
            システム管理からテナントを作成してください。
          {:else}
            主催者にメンバーへの追加を依頼してください。
          {/if}
        </p>
        {#if store.isSystemAdmin}
          <div class="field-row">
            <wa-button variant="brand" onclick={showSystemAdmin}>
              <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> システム管理を開く
            </wa-button>
          </div>
        {/if}
      {:else}
        <ul class="tenant-grid">
          {#each store.tenants as t (t.id)}
            <li class="tenant-card">
              <div class="tenant-card-head">
                <span class="tenant-card-name">{t.name}</span>
                <span class="tenant-card-role">{roleLabel(t.role)}</span>
              </div>
              <div class="tenant-card-id">ID: {t.id}</div>
              <wa-button variant="brand" onclick={() => openTenant(t.id)}>
                <i class="fa-solid fa-arrow-right fa-fw" aria-hidden="true"></i> 開く
              </wa-button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </main>
</div>
