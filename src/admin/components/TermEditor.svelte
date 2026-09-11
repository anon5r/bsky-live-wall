<script>
  /**
   * 監視対象 (ハッシュタグ / キーワード) の追加・チップ表示・削除。
   * 既存ウォールの監視対象編集と、新規ウォール作成フォームの両方で使う。
   */
  import { enterKey } from '../lib/ime.js';
  import { APPROVAL_LABELS } from '../lib/store.svelte.js';

  let {
    terms,
    onAdd,
    onRemove,
    /** 語ごとの承認要否を変えられるようにする場合に渡す (term, requireApproval) => void */
    onApprovalChange = null,
    /** 閲覧だけ (モデレーターなど)。追加・削除の導線を出さない */
    readonly = false,
    disabled = false,
    showKeywordWarning = false,
    addButtonVariant = 'brand',
    addLabel = '追加',
    placeholder = 'myevent2026',
    emptyMessage = '監視対象がありません。',
  } = $props();

  let inputEl = $state(null);

  // 同じ画面に複数置かれるため、ツールチップの結び付けに使う id は一意にする。
  const uid = $props.id();
  const hashtagButtonId = uid + '-add-hashtag';
  const keywordButtonId = uid + '-add-keyword';

  const keywordCount = $derived((terms || []).filter((t) => t.type === 'keyword').length);

  /**
   * 種別を選んでから追加するのではなく、種別ごとのボタンで直接追加する。
   * 会場では 1 手でも少ないほうがよいため。Enter はハッシュタグ (既定) に割り当てる。
   */
  function submit(isKeyword) {
    const raw = (inputEl && inputEl.value) || '';
    const ok = onAdd(raw, isKeyword);
    if (ok !== false && inputEl) {
      inputEl.value = '';
      try {
        inputEl.focus();
      } catch {
        // フォーカスできなくても致命的ではない
      }
    }
  }

  const submitHashtag = () => submit(false);
  const submitKeyword = () => submit(true);

  function iconFor(type) {
    return type === 'hashtag' ? 'fa-solid fa-hashtag' : 'fa-solid fa-font';
  }

  function approvalOf(term) {
    return term.requireApproval || 'inherit';
  }

  function onApprovalSelect(term, evt) {
    const next = evt.target && evt.target.value;
    if (!next || next === approvalOf(term)) return;
    onApprovalChange(term, next);
  }
</script>

{#if !readonly}
<div class="field-row">
  <wa-input bind:this={inputEl} autocomplete="off" {placeholder} {disabled} use:enterKey={submitHashtag}></wa-input>
  <wa-button
    id={hashtagButtonId}
    variant={addButtonVariant}
    appearance={addButtonVariant === 'brand' ? 'filled' : 'outlined'}
    {disabled}
    aria-label={'ハッシュタグとして' + addLabel}
    onclick={submitHashtag}
  >
    <i class="fa-solid fa-hashtag fa-fw" aria-hidden="true"></i> {addLabel}
  </wa-button>
  <wa-tooltip for={hashtagButtonId}>ハッシュタグとして{addLabel} (タグの完全一致)</wa-tooltip>
  <wa-button
    id={keywordButtonId}
    variant="warning"
    appearance="outlined"
    {disabled}
    aria-label={'キーワードとして' + addLabel}
    onclick={submitKeyword}
  >
    <i class="fa-solid fa-font fa-fw" aria-hidden="true"></i> {addLabel}
  </wa-button>
  <wa-tooltip for={keywordButtonId}>キーワードとして{addLabel} (本文の部分一致)</wa-tooltip>
</div>
<p class="field-note term-add-note">
  <i class="fa-solid fa-hashtag fa-fw" aria-hidden="true"></i> はハッシュタグ (Enter も同じ)、
  <i class="fa-solid fa-font fa-fw" aria-hidden="true"></i> はキーワード (本文の部分一致) として追加します。
</p>
{/if}

{#if showKeywordWarning && keywordCount > 0}
  <wa-callout variant="warning">
    <i class="fa-solid fa-triangle-exclamation fa-fw" aria-hidden="true"></i>
    キーワード {keywordCount} 件が有効です。ハッシュタグの付かない投稿は、イベントを知らない第三者のものである可能性があります。
    既定ではキーワードのみ一致した投稿は下の「承認待ち」に入り、承認するまで会場モニターには出ません。
  </wa-callout>
{/if}

<ul class="term-rows">
  {#each terms || [] as term (term.type + ':' + term.value)}
    <li class={(onApprovalChange ? 'term-row term-row-approval' : 'term-row') + (readonly ? ' term-row-readonly' : '')}>
      <span class={'term-row-icon term-row-icon-' + term.type} aria-hidden="true">
        <i class={iconFor(term.type)}></i>
      </span>
      <span class="term-row-value">{term.value}</span>
      <span class="term-row-type">{term.type === 'hashtag' ? 'タグ' : 'キーワード'}</span>
      {#if onApprovalChange}
        <wa-select
          size="s"
          class="term-approval-select"
          value={approvalOf(term)}
          aria-label={term.value + ' の承認要否'}
          {disabled}
          onchange={(evt) => onApprovalSelect(term, evt)}
        >
          {#each Object.keys(APPROVAL_LABELS) as key (key)}
            <wa-option value={key}>{APPROVAL_LABELS[key]}</wa-option>
          {/each}
        </wa-select>
      {/if}
      {#if !readonly}
        <button
          type="button"
          class="term-row-remove"
          aria-label={(term.type === 'hashtag' ? 'ハッシュタグ ' : 'キーワード ') + term.value + ' を削除'}
          {disabled}
          onclick={() => onRemove(term)}
        >
          <i class="fa-solid fa-xmark fa-fw" aria-hidden="true"></i>
        </button>
      {/if}
    </li>
  {/each}
</ul>
{#if !terms || terms.length === 0}
  <p class="empty-msg">{emptyMessage}</p>
{/if}
