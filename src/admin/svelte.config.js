/**
 * vite-plugin-svelte は Vite の root (このディレクトリ) から設定を探すため、
 * ここに置く必要がある。設定の実体はリポジトリ直下の svelte.config.js で、
 * エディタもそちらを見る。二重管理にならないよう再エクスポートするだけにする。
 */
export { default } from '../../svelte.config.js';
