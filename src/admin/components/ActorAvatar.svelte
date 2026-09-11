<script>
  /**
   * Bluesky のアバター画像。
   * 画像が無い・読み込めない場合は表示名 (無ければハンドル) の頭文字で代用する。
   * 大きさは size (px) で指定する。
   */
  let { avatar = '', handle = '', displayName = '', size = 40 } = $props();

  let failed = $state(false);
  // アバターが差し替わったら、前回の読み込み失敗は引きずらない。
  $effect(() => {
    avatar;
    failed = false;
  });

  const initial = $derived(
    ((displayName || handle || '?').replace(/^@/, '').trim().charAt(0) || '?').toUpperCase()
  );
  const sizeStyle = $derived('--actor-avatar-size: ' + size + 'px');
</script>

{#if avatar && !failed}
  <img
    class="actor-avatar"
    src={avatar}
    alt=""
    style={sizeStyle}
    loading="lazy"
    referrerpolicy="no-referrer"
    onerror={() => (failed = true)}
  />
{:else}
  <span class="actor-avatar actor-avatar-fallback" style={sizeStyle} aria-hidden="true">{initial}</span>
{/if}
