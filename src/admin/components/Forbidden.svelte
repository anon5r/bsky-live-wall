<script>
  /**
   * multi モードで /e/<tenant>/admin を直接開いたが、権限が無い (または存在しない
   * テナントだった) 場合の画面。真っ白になったり例外で壊れたりしないよう、
   * サーバーの応答メッセージをそのまま見せて、テナント一覧へ戻る導線を出す。
   */
  import { store, showTenantSelect, logout } from '../lib/store.svelte.js';
</script>

<section class="login-screen">
  <div class="login-card">
    <h1><i class="fa-solid fa-lock fa-fw" aria-hidden="true"></i> 権限がありません</h1>
    <p class="login-desc">{store.forbiddenMessage}</p>
    <div class="login-actions">
      <wa-button variant="brand" class="btn-large" onclick={showTenantSelect}>
        <i class="fa-solid fa-list fa-fw" aria-hidden="true"></i> テナント一覧へ
      </wa-button>
      <wa-button appearance="plain" variant="neutral" onclick={logout}>
        <i class="fa-solid fa-right-from-bracket fa-fw" aria-hidden="true"></i> ログアウト
      </wa-button>
    </div>
  </div>
</section>
