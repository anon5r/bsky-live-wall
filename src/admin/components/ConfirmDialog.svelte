<script>
  import { store, confirmOk, confirmCancel } from '../lib/store.svelte.js';

  let dialogEl = $state(null);

  $effect(() => {
    if (dialogEl) dialogEl.open = store.confirm.open;
  });

  function onAfterHide() {
    // Escape キー等、ボタン以外の経路で閉じた場合の後始末。
    if (store.confirm.open) confirmCancel();
  }
</script>

<wa-dialog bind:this={dialogEl} label="確認" onwa-after-hide={onAfterHide}>
  <p class="confirm-message">{store.confirm.message}</p>
  <wa-button slot="footer" appearance="plain" variant="neutral" onclick={confirmCancel}>
    <i class="fa-solid fa-xmark fa-fw" aria-hidden="true"></i> キャンセル
  </wa-button>
  <wa-button slot="footer" variant="danger" onclick={confirmOk}>
    <i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i> 実行する
  </wa-button>
</wa-dialog>
