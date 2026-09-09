<script>
  import { store } from '../lib/store.svelte.js';
</script>

<div class="toast" hidden={!store.toast.visible} role="alert">{store.toast.message}</div>
