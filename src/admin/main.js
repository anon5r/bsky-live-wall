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

// 使用する Web Awesome コンポーネントをまとめて import する。
// <wa-icon> は使わない (取得元設定を持ち込むため)。既存の Font Awesome
// クラス (<i class="fa-solid ...">) をそのまま各コンポーネントのスロットに入れる。
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';

import { mount } from 'svelte';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app') });
