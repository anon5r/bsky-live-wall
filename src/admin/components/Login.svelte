<script>
  import { store, submitTokenLogin, oauthLogin } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';

  let handleInputEl = $state(null);
  let tokenInputEl = $state(null);
  let oauthBusy = $state(false);
  let connectBusy = $state(false);

  async function handleOauth() {
    oauthBusy = true;
    const handle = (handleInputEl && handleInputEl.value) || '';
    const ok = await oauthLogin(handle.trim());
    if (!ok) oauthBusy = false;
  }

  async function doTokenLogin() {
    connectBusy = true;
    const token = (tokenInputEl && tokenInputEl.value) || '';
    await submitTokenLogin(token);
    connectBusy = false;
    if (tokenInputEl) tokenInputEl.value = '';
  }

  function handleTokenSubmit(evt) {
    evt.preventDefault();
    doTokenLogin();
  }

  function clearToken() {
    if (tokenInputEl) tokenInputEl.value = '';
  }

  $effect(() => {
    if (tokenInputEl) {
      const el = tokenInputEl;
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        try {
          el.focus();
        } catch {
          // フォーカスできなくても致命的ではない
        }
      });
    }
  });
</script>

<section class="login-screen">
  <div class="login-card">
    <h1>Bluesky Live Wall 管理画面</h1>
    {#if store.loginError}
      <div class="login-error">{store.loginError}</div>
    {/if}

    {#if store.authConfig.oauth}
      <div class="login-method">
        <p class="login-desc">Bluesky のアカウントでログインします。</p>
        <wa-input
          bind:this={handleInputEl}
          label="ハンドル または DID"
          autocomplete="username"
          inputmode="url"
          placeholder="alice.bsky.social"
          use:enterKey={handleOauth}
        ></wa-input>
        <div class="login-actions">
          <wa-button variant="brand" class="btn-large" disabled={oauthBusy} onclick={handleOauth}>
            <i class="fa-brands fa-bluesky fa-fw" aria-hidden="true"></i> Bluesky でログイン
          </wa-button>
        </div>
        <p class="login-note">パスワードはこのサイトに入力しません。認証はご自身の PDS で行われます。</p>
      </div>
    {/if}

    {#if store.authConfig.oauth && store.authConfig.token}
      <div class="login-divider"><span>または</span></div>
    {/if}

    {#if store.authConfig.token}
      <form class="login-method" autocomplete="on" onsubmit={handleTokenSubmit}>
        <p class="login-desc">ADMIN_TOKEN を入力してください。未設定 (ローカル運用) の場合は空のまま接続できます。</p>
        <wa-input
          bind:this={tokenInputEl}
          type="password"
          name="admin-token"
          label="ADMIN_TOKEN"
          autocomplete="current-password"
          password-toggle
          placeholder="トークンを入力 (任意)"
          use:enterKey={doTokenLogin}
        ></wa-input>
        <div class="login-actions">
          <wa-button type="submit" variant="brand" class="btn-large" disabled={connectBusy}>
            <i class="fa-solid fa-right-to-bracket fa-fw" aria-hidden="true"></i> 接続
          </wa-button>
          <wa-button type="button" appearance="plain" variant="neutral" onclick={clearToken}>
            <i class="fa-solid fa-eraser fa-fw" aria-hidden="true"></i> トークンを消去
          </wa-button>
        </div>
      </form>
    {/if}
  </div>
</section>
