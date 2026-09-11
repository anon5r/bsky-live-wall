<script>
  /**
   * 取り込む投稿の言語フィルタ。
   * 何も選んでいなければ全言語 (絞り込みなし)。
   * 言語は数が多いため、文字で絞りながら選ぶ。
   */
  import { listLangs, langLabel } from '../lib/langs.js';

  let { langs = [], onChange, readonly = false, note = '' } = $props();

  let query = $state('');
  let queryInputEl = $state(null);

  const selected = $derived(Array.isArray(langs) ? langs : []);
  const all = $derived(listLangs(selected));
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return all;
    return all.filter((lang) => lang.search.includes(q));
  });

  function toggle(code) {
    if (readonly) return;
    onChange(
      selected.includes(code) ? selected.filter((c) => c !== code) : selected.concat([code])
    );
  }

  function clearAll() {
    if (readonly) return;
    onChange([]);
  }

  function onQueryInput(evt) {
    query = (evt.target && evt.target.value) || '';
  }
</script>

<div class="field">
  <span class="control-label">
    <i class="fa-solid fa-language fa-fw" aria-hidden="true"></i> 取り込む言語
    <span class="control-note">
      {selected.length === 0
        ? '絞り込みなし (すべての言語を取り込みます)'
        : selected.length + ' 言語のみ取り込みます'}
    </span>
  </span>

  {#if selected.length > 0}
    <ul class="lang-selected">
      {#each selected as code (code)}
        <li>
          <button
            type="button"
            class="lang-chip is-on"
            disabled={readonly}
            aria-label={langLabel(code) + ' を外す'}
            onclick={() => toggle(code)}
          >
            {langLabel(code)}
            <span class="lang-chip-code">{code}</span>
            {#if !readonly}<i class="fa-solid fa-xmark" aria-hidden="true"></i>{/if}
          </button>
        </li>
      {/each}
      {#if !readonly}
        <li>
          <button type="button" class="lang-clear" onclick={clearAll}>
            <i class="fa-solid fa-rotate-left fa-fw" aria-hidden="true"></i> 絞り込みを外す
          </button>
        </li>
      {/if}
    </ul>
  {/if}

  {#if !readonly}
    <wa-input
      bind:this={queryInputEl}
      size="s"
      class="lang-search"
      autocomplete="off"
      placeholder="言語を探す (日本語・英語・コード)"
      aria-label="言語を探す"
      value={query}
      oninput={onQueryInput}
    >
      <i class="fa-solid fa-magnifying-glass fa-fw" slot="start" aria-hidden="true"></i>
    </wa-input>

    <ul class="lang-list" role="group" aria-label="取り込む言語">
      {#each filtered as lang (lang.code)}
        <li>
          <button
            type="button"
            class={'lang-option' + (selected.includes(lang.code) ? ' is-on' : '')}
            aria-pressed={selected.includes(lang.code)}
            onclick={() => toggle(lang.code)}
          >
            <i
              class={(selected.includes(lang.code)
                ? 'fa-solid fa-square-check'
                : 'fa-regular fa-square') + ' fa-fw lang-option-check'}
              aria-hidden="true"
            ></i>
            <span class="lang-option-name">{lang.label}</span>
            <span class="lang-option-sub">{lang.sub}</span>
            <span class="lang-chip-code">{lang.code}</span>
          </button>
        </li>
      {:else}
        <li class="lang-empty">「{query}」に一致する言語がありません。</li>
      {/each}
    </ul>
  {/if}

  <p class="field-note">
    {note}
    言語は投稿側の指定 (BCP-47) で判定します。<code>en</code> を選ぶと <code>en-US</code> の投稿も入ります。
    絞り込みを有効にすると、言語の指定が無い投稿は取り込みません。
  </p>
</div>
