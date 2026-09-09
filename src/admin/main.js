/**
 * 管理画面のエントリポイント。
 *
 * Web Awesome と Font Awesome は import してバンドルへ含める。
 * こうすることで CDN も importmap も不要になり、配信されるのは
 * ビルド済みの自己完結したファイルだけになる。
 */
import '@awesome.me/webawesome/dist/styles/webawesome.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import './app.css';

import { mount } from 'svelte';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app') });
