<script>
  /**
   * インライン二段階確認ボタン。
   * 1 回目のクリックで「本当に？」に変わり、既定 10 秒以内に再クリックで確定。
   * window.confirm 等のブラウザダイアログは使用しない。
   */
  const CONFIRM_TIMEOUT_MS = 10000;

  let {
    label,
    icon = 'fa-solid fa-circle-question',
    confirmLabel = '本当に？',
    className = 'btn btn-danger btn-small',
    onConfirm,
  } = $props();

  let confirming = $state(false);
  let resetTimer = null;

  function reset() {
    confirming = false;
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  }

  function handleClick() {
    if (!confirming) {
      confirming = true;
      resetTimer = setTimeout(reset, CONFIRM_TIMEOUT_MS);
      return;
    }
    reset();
    onConfirm();
  }

  $effect(() => () => {
    if (resetTimer) clearTimeout(resetTimer);
  });
</script>

<button type="button" class={className + (confirming ? ' btn-confirming' : '')} onclick={handleClick}>
  <i class={(confirming ? 'fa-solid fa-triangle-exclamation' : icon) + ' fa-fw'} aria-hidden="true"></i>
  <span>{confirming ? confirmLabel : label}</span>
</button>
