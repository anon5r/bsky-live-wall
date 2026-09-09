<script>
  /**
   * 監視対象 (ハッシュタグ / キーワード) の追加・チップ表示・削除。
   * 既存ウォールの監視対象編集と、新規ウォール作成フォームの両方で使う。
   */
  import { enterKey } from '../lib/ime.js';

  let {
    terms,
    onAdd,
    onRemove,
    disabled = false,
    showKeywordWarning = false,
    addButtonVariant = 'brand',
    addLabel = '追加',
    placeholder = 'myevent2026',
    emptyMessage = '監視対象がありません。',
  } = $props();

  let inputEl = $state(null);
  let checkboxEl = $state(null);
  let keywordChecked = false;

  const keywordCount = $derived((terms || []).filter((t) => t.type === 'keyword').length);

  function onCheckboxChange() {
    keywordChecked = !!(checkboxEl && checkboxEl.checked);
  }

  function submit() {
    const raw = (inputEl && inputEl.value) || '';
    const ok = onAdd(raw, keywordChecked);
    if (ok !== false && inputEl) {
      inputEl.value = '';
      try {
        inputEl.focus();
      } catch {
        // フォーカスできなくても致命的ではない
      }
    }
  }

  function iconFor(type) {
    return type === 'hashtag' ? 'fa-solid fa-hashtag' : 'fa-solid fa-font';
  }
</script>

<div class="field-row">
  <wa-input bind:this={inputEl} autocomplete="off" {placeholder} {disabled} use:enterKey={submit}></wa-input>
  <wa-button variant={addButtonVariant} appearance={addButtonVariant === 'brand' ? 'filled' : 'outlined'} {disabled} onclick={submit}>
    <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> {addLabel}
  </wa-button>
</div>
<wa-checkbox bind:this={checkboxEl} {disabled} onchange={onCheckboxChange}>
  <i class="fa-solid fa-font fa-fw" aria-hidden="true"></i> キーワードとして追加する (本文の部分一致)
</wa-checkbox>

{#if showKeywordWarning && keywordCount > 0}
  <wa-callout variant="warning">
    <i class="fa-solid fa-triangle-exclamation fa-fw" aria-hidden="true"></i>
    キーワード {keywordCount} 件が有効です。ハッシュタグの付かない投稿は、イベントを知らない第三者のものである可能性があります。
    既定ではキーワードのみ一致した投稿は下の「承認待ち」に入り、承認するまで会場モニターには出ません。
  </wa-callout>
{/if}

<ul class="term-list">
  {#each terms || [] as term (term.type + ':' + term.value)}
    <li>
      <wa-tag
        with-remove
        variant={term.type === 'hashtag' ? 'brand' : 'warning'}
        aria-label={(term.type === 'hashtag' ? 'ハッシュタグ ' : 'キーワード ') + term.value + ' を削除'}
        onwa-remove={() => onRemove(term)}
      >
        <i class={iconFor(term.type)} aria-hidden="true"></i> {term.value}
      </wa-tag>
    </li>
  {/each}
</ul>
{#if !terms || terms.length === 0}
  <p class="empty-msg">{emptyMessage}</p>
{/if}
