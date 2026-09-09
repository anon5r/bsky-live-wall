/**
 * 管理画面の共有状態とロジック。
 *
 * legacy-admin.js の状態管理・API 呼び出しを、Svelte 5 の runes を使った
 * 1 個のシングルトンストアへ集約したもの。コンポーネントはこのストアの
 * フィールドを読み書きし、ポーリングやログイン/ログアウトなどの手続きは
 * ここに定義した関数を呼び出すだけでよい。
 */
import { apiFetch, callAdminApi, setUnauthorizedHandler } from './api.js';

const STORAGE_THEME_KEY = 'bsky_live_wall_admin_theme';
const STORAGE_WALL_KEY = 'bsky_live_wall_admin_wall_id';
const POLL_INTERVAL_MS = 3000;
export const MAX_WALLS = 10;

function loadWallId() {
  try {
    return localStorage.getItem(STORAGE_WALL_KEY) || '';
  } catch {
    return '';
  }
}

function saveWallId(id) {
  try {
    if (id) {
      localStorage.setItem(STORAGE_WALL_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_WALL_KEY);
    }
  } catch {
    // 無視。保存できなくても動作に支障はない。
  }
}

function removeLegacyToken() {
  try {
    // 過去のバージョンが保存したトークンがあれば消しておく。
    localStorage.removeItem('bsky_live_wall_admin_token');
  } catch {
    // 無視
  }
}

function loadTheme() {
  try {
    return localStorage.getItem(STORAGE_THEME_KEY) || '';
  } catch {
    return '';
  }
}

function prefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function effectiveTheme(theme) {
  if (theme === 'dark' || theme === 'light') return theme;
  return prefersDark() ? 'dark' : 'light';
}

export const store = $state({
  // 画面
  page: 'login', // 'login' | 'app'
  loginError: '',
  authConfig: { token: true, oauth: false },

  // テーマ (実際に適用されている明暗。'dark' | 'light')
  theme: effectiveTheme(loadTheme()),

  // ウォール
  currentWallId: loadWallId(),
  walls: [],

  // 選択中ウォールの状態 (WallState そのまま)
  state: {
    wallId: '',
    wallName: '-',
    terms: [],
    paused: false,
    moderationMode: 'open',
    jetstream: { connected: false, host: null, reconnects: null },
    stats: { matched: 0, displayed: 0, rejected: 0, authors: 0, startedAt: 0 },
  },
  recent: [],
  pending: [],
  hidden: [],
  blocked: [],
  modLists: [],
  jetstreamHosts: [],
  backfill: null,

  uptimeText: '-',

  sessionCount: 0,
  sessionExpiresAt: 0,

  toast: { message: '', visible: false },
  confirm: { message: '', open: false },
});

let confirmHandler = null;
let toastHideTimer = null;
let pollTimer = null;
let serverStartedAt = 0;
let pauseRequestInFlight = false;
let sessionInfoAt = 0;
let lastBackfillFinishedAt = 0;

// ==========================================================
// テーマ
// ==========================================================

export function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const eff = effectiveTheme(theme);
  document.documentElement.classList.toggle('wa-dark', eff === 'dark');
  document.documentElement.classList.toggle('wa-light', eff === 'light');
  store.theme = eff;
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const effectiveCurrent = current || (prefersDark() ? 'dark' : 'light');
  const next = effectiveCurrent === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(STORAGE_THEME_KEY, next);
  } catch {
    // 無視
  }
}

applyTheme(loadTheme());
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.getAttribute('data-theme')) {
      applyTheme('');
    }
  });
}

// 稼働時間は 1 秒ごとに進める。ポーリング間隔 (3 秒) に引きずられない。
if (typeof window !== 'undefined') {
  setInterval(() => {
    if (serverStartedAt) store.uptimeText = formatUptime(serverStartedAt);
  }, 1000);
}

// ==========================================================
// トースト
// ==========================================================

export function showToast(message) {
  store.toast = { message, visible: true };
  if (toastHideTimer) clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => {
    store.toast = { ...store.toast, visible: false };
  }, 4000);
}

// ==========================================================
// 確認ダイアログ
// ==========================================================

export function openConfirm(message, onOk) {
  confirmHandler = onOk;
  store.confirm = { message, open: true };
}

export function confirmOk() {
  const handler = confirmHandler;
  confirmHandler = null;
  store.confirm = { ...store.confirm, open: false };
  if (handler) handler();
}

export function confirmCancel() {
  confirmHandler = null;
  store.confirm = { ...store.confirm, open: false };
}

// ==========================================================
// 認証まわり
// ==========================================================

function handleUnauthorized() {
  stopPolling();
  sessionExpiresAt_reset();
  showLogin(
    store.authConfig.oauth && !store.authConfig.token
      ? 'セッションの有効期限が切れました。もう一度ログインしてください。'
      : 'セッションが無効になりました。もう一度ログインしてください。'
  );
}
setUnauthorizedHandler(handleUnauthorized);

function sessionExpiresAt_reset() {
  store.sessionExpiresAt = 0;
}

function showLogin(errorMessage) {
  store.page = 'login';
  store.loginError = errorMessage || '';
}

function showApp() {
  store.page = 'app';
}

function readAuthError() {
  const params = new URLSearchParams(location.search);
  const err = params.get('error');
  if (!err) return '';
  history.replaceState(null, '', location.pathname);
  if (err === 'not_allowed') {
    return 'このアカウントは管理を許可されていません。主催者に ADMIN_ACTORS への追加を依頼してください。';
  }
  return 'ログインに失敗しました。もう一度お試しください。';
}

async function applyAuthConfig() {
  try {
    const res = await fetch('/api/auth/config', { credentials: 'same-origin' });
    store.authConfig = res.ok ? await res.json() : { token: true, oauth: false };
  } catch {
    store.authConfig = { token: true, oauth: false };
  }
}

export async function init() {
  removeLegacyToken();
  const authError = readAuthError();
  await applyAuthConfig();
  if (authError) {
    showLogin(authError);
    return;
  }
  try {
    const res = await apiFetch('/api/admin/state');
    if (!res.ok) {
      showLogin();
      return;
    }
    connect();
  } catch {
    showLogin();
  }
}

function connect() {
  showApp();
  startPolling();
}

export async function submitTokenLogin(token) {
  try {
    const res = await apiFetch('/api/admin/session', {
      method: 'POST',
      body: JSON.stringify({ token: token || '' }),
    });
    if (res.status === 429) {
      showLogin('試行回数が多すぎます。しばらく待ってからやり直してください。');
      return false;
    }
    if (!res.ok) {
      showLogin('トークンが正しくありません');
      return false;
    }
    const data = await res.json();
    store.sessionExpiresAt = data.expiresAt || 0;
    connect();
    return true;
  } catch {
    showLogin('サーバーに接続できません');
    return false;
  }
}

export async function oauthLogin(handle) {
  if (!handle) {
    showLogin('ハンドルを入力してください');
    return false;
  }
  try {
    const res = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ handle }) });
    const data = res.ok ? await res.json() : null;
    if (!data || !data.url) {
      showLogin('アカウントを解決できませんでした。ハンドルを確認してください。');
      return false;
    }
    // 認可のため利用者の PDS へ遷移する。
    location.href = data.url;
    return true;
  } catch {
    showLogin('サーバーに接続できません');
    return false;
  }
}

export async function logout() {
  stopPolling();
  try {
    await apiFetch('/api/admin/session', { method: 'DELETE' });
  } catch {
    // 失効できなくても画面は戻す
  }
  store.sessionExpiresAt = 0;
  showLogin();
}

export async function revokeAllSessions() {
  try {
    await callAdminApi('/api/admin/sessions/revoke-all');
    stopPolling();
    store.sessionExpiresAt = 0;
    showLogin('全セッションを失効しました。再度ログインしてください。');
  } catch {
    showToast('失効に失敗しました');
  }
}

// ==========================================================
// ポーリング
// ==========================================================

export function startPolling() {
  stopPolling();
  fetchState();
  pollTimer = setInterval(fetchState, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export async function fetchState() {
  const requestedWallId = store.currentWallId;
  const query = requestedWallId ? '?wall=' + encodeURIComponent(requestedWallId) : '';
  try {
    const res = await apiFetch('/api/admin/state' + query);
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (res.status === 404) {
      if (requestedWallId) {
        store.currentWallId = '';
        saveWallId('');
        showToast('選択していたウォールが見つからないため、既定ウォールに戻しました');
        await fetchState();
        return;
      }
      throw new Error('wall not found');
    }
    if (!res.ok) {
      throw new Error('サーバーエラー (' + res.status + ')');
    }
    const data = await res.json();
    if (requestedWallId !== store.currentWallId) {
      // その間に選択ウォールが変わった。古い応答なので破棄する。
      return;
    }
    if (!store.currentWallId && data.state && data.state.wallId) {
      store.currentWallId = data.state.wallId;
      saveWallId(store.currentWallId);
    }
    renderState(data);
  } catch {
    showToast('通信エラー: 状態を取得できませんでした');
  }
}

function renderState(data) {
  const state = data.state || {};
  store.state = state;
  serverStartedAt = (state.stats && state.stats.startedAt) || 0;
  store.uptimeText = formatUptime(serverStartedAt);

  store.walls = data.walls || [];
  store.modLists = data.modLists || [];
  store.hidden = data.hidden || [];
  store.blocked = data.blocked || [];
  store.jetstreamHosts = data.jetstreamHosts || [];
  store.pending = data.pending || [];
  store.recent = data.recent || [];

  renderBackfillStatus(data.backfill);
  refreshSessionInfo();
}

function renderBackfillStatus(status) {
  if (!status) {
    store.backfill = null;
    return;
  }
  if (!status.running && status.finishedAt && status.finishedAt !== lastBackfillFinishedAt) {
    if (lastBackfillFinishedAt !== 0) {
      showToast(status.added + ' 件を取り込みました');
    }
    lastBackfillFinishedAt = status.finishedAt;
  }
  store.backfill = status;
}

function refreshSessionInfo() {
  const now = Date.now();
  if (now - sessionInfoAt < 30000) return;
  sessionInfoAt = now;
  apiFetch('/api/admin/sessions')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      store.sessionCount = (data.sessions || []).length;
    })
    .catch(() => {
      // 表示できなくても運用に支障はない
    });
}

export function sessionExpiryLabel() {
  if (!store.sessionExpiresAt) return '';
  const remainMin = Math.max(0, Math.round((store.sessionExpiresAt - Date.now()) / 60000));
  const hours = Math.floor(remainMin / 60);
  const mins = remainMin % 60;
  return '(自分の残り ' + (hours > 0 ? hours + '時間' : '') + mins + '分)';
}

export function formatUptime(startedAt) {
  if (!startedAt) return '-';
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return h + ':' + pad(m) + ':' + pad(s);
}

export function formatTime(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  } catch {
    return '-';
  }
}

export function wallNameOf(id) {
  const w = store.walls.find((x) => x.id === id);
  return w ? w.name : id;
}

// ==========================================================
// ウォール切り替え・作成・改名・削除
// ==========================================================

export function switchWall(id) {
  if (!id || id === store.currentWallId) return;
  store.currentWallId = id;
  saveWallId(id);
  fetchState();
}

export async function createWall(name, terms) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) {
    showToast('ウォール名を入力してください');
    return false;
  }
  if (!terms || terms.length === 0) {
    showToast('監視語を 1 つ以上追加してください');
    return false;
  }
  if (store.walls.length >= MAX_WALLS) {
    showToast('ウォールは ' + MAX_WALLS + ' 個までです');
    return false;
  }
  try {
    const res = await apiFetch('/api/admin/walls', {
      method: 'POST',
      body: JSON.stringify({
        name: trimmedName,
        terms: terms.map((t) => ({ value: t.value, type: t.type })),
      }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error) || 'request failed');
    }
    const data = await res.json();
    showToast('ウォール「' + data.wall.name + '」を作成しました');
    store.currentWallId = data.wall.id;
    saveWallId(store.currentWallId);
    await fetchState();
    return true;
  } catch (err) {
    showToast(err && err.message ? err.message : 'ウォールの作成に失敗しました');
    return false;
  }
}

export async function renameWall(wall, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) {
    showToast('ウォール名を入力してください');
    return false;
  }
  try {
    const res = await apiFetch('/api/admin/walls/' + encodeURIComponent(wall.id), {
      method: 'PATCH',
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!res.ok) throw new Error('request failed');
    showToast('ウォール名を変更しました');
    await fetchState();
    return true;
  } catch {
    showToast('名前の変更に失敗しました');
    return false;
  }
}

export function requestDeleteWall(wall) {
  openConfirm('ウォール「' + wall.name + '」を削除します。よろしいですか？ 表示中の投稿もすべて失われます。', async () => {
    try {
      const res = await apiFetch('/api/admin/walls/' + encodeURIComponent(wall.id), { method: 'DELETE' });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error('request failed');
      showToast('ウォール「' + wall.name + '」を削除しました');
      if (store.currentWallId === wall.id) {
        store.currentWallId = '';
        saveWallId('');
      }
      await fetchState();
    } catch {
      showToast('削除に失敗しました');
    }
  });
}

// ==========================================================
// 監視対象
// ==========================================================

export function parseTermInput(raw, isKeyword) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { error: '監視する語を入力してください' };
  const type = isKeyword ? 'keyword' : 'hashtag';
  const value = type === 'hashtag' ? trimmed.replace(/^[#＃]+/, '') : trimmed;
  if (!value) return { error: '監視する語を入力してください' };
  if (type === 'keyword' && value.length < 2) {
    return { error: 'キーワードは 2 文字以上で指定してください' };
  }
  return { term: { value, type } };
}

export async function saveTerms(terms, successMessage) {
  const payload = terms.map((t) => ({ value: t.value, type: t.type }));
  try {
    await callAdminApi('/api/admin/terms', { terms: payload, wall: store.currentWallId || undefined });
    showToast(successMessage);
    await fetchState();
    return true;
  } catch {
    showToast('監視対象の更新に失敗しました');
    return false;
  }
}

export function addTerm(raw, isKeyword) {
  const result = parseTermInput(raw, isKeyword);
  if (result.error) {
    showToast(result.error);
    return false;
  }
  const currentTerms = store.state.terms || [];
  const duplicated = currentTerms.some(
    (t) => t.type === result.term.type && t.value.toLowerCase() === result.term.value.toLowerCase()
  );
  if (duplicated) {
    showToast('すでに登録されています');
    return false;
  }
  saveTerms(currentTerms.concat([result.term]), '監視対象に追加しました');
  return true;
}

export function requestRemoveTerm(term) {
  const kind = term.type === 'hashtag' ? 'ハッシュタグ' : 'キーワード';
  openConfirm(kind + '「' + term.value + '」を監視対象から外します。よろしいですか？', () => {
    const currentTerms = store.state.terms || [];
    const next = currentTerms.filter((t) => !(t.value === term.value && t.type === term.type));
    if (next.length === 0) {
      showToast('監視対象を 0 件にはできません');
      return;
    }
    saveTerms(next, '監視対象から外しました');
  });
}

// ==========================================================
// 投稿の操作
// ==========================================================

export async function approvePost(uri) {
  try {
    await callAdminApi('/api/admin/approve', { uri, wall: store.currentWallId || undefined });
    await fetchState();
  } catch {
    showToast('承認に失敗しました');
  }
}

export async function hidePost(uri) {
  try {
    await callAdminApi('/api/admin/hide', { uri });
    await fetchState();
  } catch {
    showToast('非表示処理に失敗しました');
  }
}

export async function unhidePost(uri) {
  try {
    await callAdminApi('/api/admin/unhide', { uri });
    await fetchState();
  } catch {
    showToast('復元に失敗しました');
  }
}

export async function blockActor(did) {
  try {
    await callAdminApi('/api/admin/block', { did });
    await fetchState();
  } catch {
    showToast('ブロックに失敗しました');
  }
}

export async function unblockActor(did) {
  try {
    await callAdminApi('/api/admin/unblock', { did });
    await fetchState();
  } catch {
    showToast('ブロック解除に失敗しました');
  }
}

export async function clearAll() {
  try {
    await callAdminApi('/api/admin/clear', { wall: store.currentWallId || undefined });
    await fetchState();
  } catch {
    showToast('全消去に失敗しました');
  }
}

// ==========================================================
// 全ウォール共通の操作
// ==========================================================

export async function togglePause(nextPaused) {
  if (pauseRequestInFlight) return;
  pauseRequestInFlight = true;
  try {
    await callAdminApi('/api/admin/pause', { paused: nextPaused });
    store.state = { ...store.state, paused: nextPaused };
  } catch {
    showToast('一時停止の切り替えに失敗しました');
  } finally {
    pauseRequestInFlight = false;
    await fetchState();
  }
}

export async function switchJetstream(host) {
  if (!host) return;
  try {
    await callAdminApi('/api/admin/jetstream', { host });
    showToast('接続先を切り替えました: ' + host);
    await fetchState();
  } catch {
    showToast('切り替えに失敗しました');
  }
}

export async function runBackfill(minutes, useCurrentWallOnly) {
  if (!minutes || minutes < 1) {
    showToast('遡る分数を 1 以上で指定してください');
    return false;
  }
  const body = { minutes };
  if (useCurrentWallOnly && store.currentWallId) body.wall = store.currentWallId;
  try {
    await callAdminApi('/api/admin/backfill', body);
    showToast('取り込みを開始しました');
    await fetchState();
    return true;
  } catch {
    showToast('取り込みを開始できませんでした');
    return false;
  }
}

export async function loadAvailableModlists(actor) {
  const path = '/api/admin/modlists/available' + (actor ? '?actor=' + encodeURIComponent(actor) : '');
  try {
    const res = await apiFetch(path);
    if (res.status === 401) {
      handleUnauthorized();
      return null;
    }
    if (!res.ok) {
      showToast('リストを取得できませんでした');
      return null;
    }
    const data = await res.json();
    return data.lists || [];
  } catch {
    showToast('リストを取得できませんでした');
    return null;
  }
}

export async function subscribeModlist(uri) {
  try {
    const res = await callAdminApi('/api/admin/modlists', { uri });
    const data = await res.json();
    showToast('購読しました (' + data.info.memberCount + ' 件 / 取り下げ ' + data.removed + ' 件)');
    await fetchState();
    return true;
  } catch {
    showToast('購読に失敗しました');
    return false;
  }
}

export async function unsubscribeModlist(uri) {
  try {
    const res = await apiFetch('/api/admin/modlists', {
      method: 'DELETE',
      body: JSON.stringify({ uri }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
  } catch {
    showToast('購読解除に失敗しました');
  }
  await fetchState();
}
