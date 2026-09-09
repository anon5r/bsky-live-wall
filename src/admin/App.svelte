<script>
  // ビルド疎通の確認用。実装はこの後で差し替える。
  import '@awesome.me/webawesome/dist/components/button/button.js';
  import '@awesome.me/webawesome/dist/components/callout/callout.js';

  let health = $state('確認中...');

  $effect(() => {
    fetch('/api/health', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => { health = d.ok ? '接続できました' : '応答が不正です'; })
      .catch(() => { health = 'サーバーに接続できません'; });
  });
</script>

<main>
  <h1>Bluesky Live Wall 管理画面</h1>
  <wa-callout>
    <i class="fa-solid fa-plug fa-fw" aria-hidden="true"></i>
    {health}
  </wa-callout>
  <wa-button variant="brand">
    <i class="fa-solid fa-check fa-fw" aria-hidden="true"></i> ビルド疎通の確認
  </wa-button>
</main>

<style>
  main { padding: 24px; }
</style>
