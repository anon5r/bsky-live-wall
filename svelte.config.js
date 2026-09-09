import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Svelte のコンパイル設定。
 *
 * vite-plugin-svelte はこのファイルを Vite の root (src/admin) から探すため、
 * リポジトリ直下に置いただけでは読み込まれない。vite.config.js から
 * 明示的に読み込んで渡している (設定を 2 箇所に持たないため)。
 */
export default {
  preprocess: vitePreprocess(),

  compilerOptions: {
    /**
     * Web Awesome のカスタム要素に対する a11y 警告を抑止する。
     *
     * Svelte のコンパイラはカスタム要素の意味を知らないため、
     * `<wa-button onclick={...}>` を「対話的でない要素にクリックを付けた」と
     * みなして警告する。実際には wa-button はシャドウ DOM 内で
     * ネイティブの <button> を描画し、delegatesFocus: true と
     * tabindex="0" を持つ (実装を確認済み)。キーボードでも操作でき、
     * 警告は誤検知にあたる。
     *
     * 抑止するのは wa-* 要素に対するこの 2 種類だけ。素の div などに
     * クリックを付けた場合は従来どおり警告が出る。
     */
    warningFilter: (warning) => {
      const falsePositives = new Set([
        'a11y_click_events_have_key_events',
        'a11y_no_static_element_interactions',
      ]);
      const isCustomElement = /`<wa-[a-z-]+>`/.test(warning.message ?? '');
      return !(falsePositives.has(warning.code) && isCustomElement);
    },
  },
};
