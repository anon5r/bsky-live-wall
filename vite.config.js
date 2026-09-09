/**
 * 管理画面 (src/admin) のビルド設定。
 *
 * 会場モニター (public/wall) は素の HTML/CSS/JS のままで、ここでは扱わない。
 * イベント当日に動かないものを増やさないため、依存を持ち込むのは管理画面だけとする。
 *
 * 出力は public/admin/ へ置く。サーバーは public/ を /assets/ で配信するため、
 * ビルド後のアセット URL は /assets/admin/... になる。
 */
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/admin', import.meta.url)),
  // 生成物は /assets/admin/ から配信される。
  base: '/assets/admin/',
  // Svelte の設定は src/admin/svelte.config.js (リポジトリ直下の再エクスポート)
  // をプラグインが自動で読み込む。
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL('./public/admin', import.meta.url)),
    emptyOutDir: true,
    // 会場での障害切り分けを楽にするため、ソースマップは出す。
    sourcemap: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/admin/index.html', import.meta.url)),
    },
  },
});
