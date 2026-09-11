<script>
  /**
   * 取り込む投稿の言語フィルタ。
   * 何も選んでいなければ全言語 (絞り込みなし)。一覧に無い言語はコードで足せる。
   */
  import { LANG_PRESETS, langLabel, normalizeLang, isValidLang } from '../lib/langs.js';
  import { showToast } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';

  let { langs = [], onChange, readonly = false, note = '' } = $props();

  let customInputEl = $state(null);

  const selected = $derived(Array.isArray(langs) ? langs : []);
  // 一覧に出す候補。選択済みの言語が一覧に無ければ、それも候補として並べる。
  const presets = $derived(
    LANG_PRESETS.concat(
      selected
        .filter((code) => !LANG_PRESETS.some((l) => l.code === code))
        .map((code) => ({ code, label: code }))
    )
  );

  function toggle(code) {
    if (readonly) return;
    const next = selected.includes(code)
      ? selected.filter((c) => c !== code)
      : selected.concat([code]);
    onChange(next);
  }

  function addCustom() {
    if (readonly) return;
    const raw = (customInputEl && customInputEl.value) || '';
    if (raw.trim() === '') return;
    if (!isValidLang(raw)) {
      showToast('言語コードとして解釈できません: ' + raw.trim());
      return;
    }
    const code = normalizeLang(raw);
    if (customInputEl) customInputEl.value = '';
    if (selected.includes(code)) return;
    onChange(selected.concat([code]));
  }

  function clearAll() {
    if (readonly) return;
    onChange([]);
  }
</script>

<div class="field">
  <span class="control-label">
    <i class="fa-solid fa-language fa-fw" aria-hidden="true"></i> 取り込む言語
    <span class="control-note">
      {selected.length === 0 ? '絞り込みなし (すべての言語を取り込みます)' : selected.map(langLabel).join('、') + ' のみ取り込みます'}
    </span>
  </span>

  <div class="lang-grid" role="group" aria-label="取り込む言語">
    {#each presets as lang (lang.code)}
      <button
        type="button"
        class={'lang-chip' + (selected.includes(lang.code) ? ' is-on' : '')}
        aria-pressed={selected.includes(lang.code)}
        disabled={readonly}
        onclick={() => toggle(lang.code)}
      >
        {lang.label}
        <span class="lang-chip-code">{lang.code}</span>
      </button>
    {/each}
  </div>

  {#if !readonly}
    <div class="field-row lang-add-row">
      <wa-input
        bind:this={customInputEl}
        size="s"
        autocomplete="off"
        placeholder="他の言語コード (例: sv)"
        aria-label="一覧に無い言語コードを追加"
        use:enterKey={addCustom}
      ></wa-input>
      <wa-button size="s" variant="neutral" appearance="outlined" onclick={addCustom}>
        <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> 追加
      </wa-button>
      {#if selected.length > 0}
        <wa-button size="s" variant="neutral" appearance="plain" onclick={clearAll}>
          <i class="fa-solid fa-rotate-left fa-fw" aria-hidden="true"></i> 絞り込みを外す
        </wa-button>
      {/if}
    </div>
  {/if}

  <p class="field-note">
    {note}
    言語は投稿側の指定 (BCP-47) で判定します。<code>en</code> を選ぶと <code>en-US</code> の投稿も入ります。
    絞り込みを有効にすると、言語の指定が無い投稿は取り込みません。
  </p>
</div>
