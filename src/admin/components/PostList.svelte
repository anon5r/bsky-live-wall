<script>
  /**
   * 投稿一覧。
   * XSS 対策: 投稿本文・表示名などはすべて Svelte のテキスト補間で挿入する
   * (自動エスケープされる)。{@html ...} は使わない。
   */
  import { formatTime, approvePost, hidePost, unhidePost, blockActor } from '../lib/store.svelte.js';
  import InlineConfirmButton from './InlineConfirmButton.svelte';

  let {
    posts,
    emptyMessage,
    showApprove = false,
    showHide = false,
    showUnhide = false,
    showBlock = false,
    rejectLabel = false,
  } = $props();

  function displayNameOf(post) {
    return (post.author && (post.author.displayName || post.author.handle)) || post.did || '(不明)';
  }

  function imageLabel(post) {
    const count = (post.images && post.images.length) || 0;
    return count > 0 ? '画像 ' + count + ' 枚' : '画像なし';
  }
</script>

<ul class="post-list">
  {#each posts as post (post.uri)}
    <li class="post-item">
      <div class="post-item-head">
        <span class="post-author">{displayNameOf(post)}</span>
        {#if post.author && post.author.handle}
          <span class="post-handle">@{post.author.handle}</span>
        {/if}
        <span class="post-time">{formatTime(post.createdAt)}</span>
      </div>
      <div class="post-text">{post.text || ''}</div>
      <div class="post-meta">{imageLabel(post)}</div>
      <div class="post-actions">
        {#if showApprove}
          <button type="button" class="btn btn-primary btn-small" onclick={() => approvePost(post.uri)}>
            <i class="fa-solid fa-check fa-fw" aria-hidden="true"></i> 承認
          </button>
        {/if}
        {#if showHide}
          <button type="button" class="btn btn-neutral btn-small" onclick={() => hidePost(post.uri)}>
            {#if rejectLabel}
              <i class="fa-solid fa-circle-xmark fa-fw" aria-hidden="true"></i> 却下
            {:else}
              <i class="fa-solid fa-eye-slash fa-fw" aria-hidden="true"></i> 非表示
            {/if}
          </button>
        {/if}
        {#if showUnhide}
          <button type="button" class="btn btn-primary btn-small" onclick={() => unhidePost(post.uri)}>
            <i class="fa-solid fa-rotate-left fa-fw" aria-hidden="true"></i> 復元
          </button>
        {/if}
        {#if showBlock && post.did}
          <InlineConfirmButton
            label="投稿者をブロック"
            icon="fa-solid fa-ban"
            confirmLabel="本当に？"
            className="btn btn-danger btn-small"
            onConfirm={() => blockActor(post.did)}
          />
        {/if}
      </div>
    </li>
  {:else}
    <p class="empty-msg">{emptyMessage}</p>
  {/each}
</ul>
