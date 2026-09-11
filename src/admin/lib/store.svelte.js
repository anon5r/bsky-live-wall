/**
 * 管理画面の共有状態とロジック。
 *
 * legacy-admin.js の状態管理・API 呼び出しを、Svelte 5 の runes を使った
 * 1 個のシングルトンストアへ集約したもの。コンポーネントはこのストアの
 * フィールドを読み書きし、ポーリングやログイン/ログアウトなどの手続きは
 * ここに定義した関数を呼び出すだけでよい。
 */
import { apiFetch, callAdminApi, setUnauthorizedHandler, setTenantPrefix, tenantPath } from './api.js';
import { setAppviewUrl, withProfiles } from './bsky.js';

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
  // 'login' | 'tenant-select' | 'forbidden' | 'system-admin' | 'app'
  page: 'login',
  loginError: '',
  authConfig: { token: true, oauth: false },

  // テーマ (実際に適用されている明暗。'dark' | 'light')
  theme: effectiveTheme(loadTheme()),

  // 認証・テナント (/api/auth/me 由来)
  mode: 'single', // 'single' | 'multi'
  did: null,
  handle: null,
  isSystemAdmin: false,
  tenants: [], // 自分が操作できるテナント一覧 [{ id, name, role }]
  tenantId: '', // 現在開いているテナント
  myRole: null, // 現在のテナントでの自分の役割 ('owner' | 'moderator' | 'system' | null)
  forbiddenMessage: '',

  // メンバー管理 (テナントごと)
  members: [],

  // システム管理
  systemOverview: null,
  systemTenants: [],
  systemAudit: [],

  // テナント設定 (/api/admin/state 由来)
  settings: {
    title: '',
    subtitle: '',
    showBlueskyLogo: true,
    animateTitleGradient: false,
    backfillPresets: [],
    allowReplies: true,
    filterLabeled: true,
    ngWords: [],
    ngPatterns: [],
  },

  // システム管理: 利用者アカウント
  systemAccounts: [],
  systemAdminEditable: false,

  // ウォール
  currentWallId: loadWallId(),
  walls: [],

  // 選択中ウォールの状態 (WallState そのまま)
  state: {
    wallId: '',
    wallName: '-',
    terms: [],
    paused: false,
    // 承認モードは継承を解決済みの実効値。設定そのものは wall* / tenant* を見る。
    moderationMode: 'open',
    moderationSource: 'tenant',
    showBlueskyLogo: true,
    animateTitleGradient: false,
    screen: { mode: 'wall' },
    screenImageUrl: null,
    wallModerationMode: 'inherit',
    keywordRequireApproval: true,
    wallKeywordRequireApproval: 'inherit',
    tenantModerationMode: 'open',
    tenantKeywordRequireApproval: true,
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
let systemPollTimer = null;
let serverStartedAt = 0;
let pauseRequestInFlight = false;
let sessionInfoAt = 0;
let lastBackfillFinishedAt = 0;
const SYSTEM_POLL_INTERVAL_MS = 5000;

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
  stopSystemPolling();
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

// ==========================================================
// 経路解決 (single / multi, テナントの特定)
// ==========================================================

/**
 * URL からテナント ID を読み取る。`/e/<tenant>/admin` の形のときだけ返す。
 * `/admin` (テナント未指定) では null を返す。
 */
function parseRouteTenant() {
  const m = location.pathname.match(/^\/e\/([^/]+)\/admin\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** `/api/auth/me` を取得して store の認証・テナント情報を更新する。 */
async function refreshMe() {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'bsky-live-wall' },
    });
    const data = res.ok ? await res.json() : { authenticated: false };
    store.did = data.did ?? null;
    store.handle = data.handle ?? null;
    store.isSystemAdmin = !!data.isSystemAdmin;
    store.mode = data.mode || 'single';
    store.tenants = data.tenants || [];
    return !!data.authenticated;
  } catch {
    store.mode = 'single';
    store.tenants = [];
    return false;
  }
}

/**
 * 会場モニターの URL。
 * multi モードではテナント接頭辞が要る (`/wall/...` は管理画面へ戻されてしまう)。
 */
export function wallUrl(wallId) {
  return tenantPath(wallId ? '/wall/' + encodeURIComponent(wallId) : '/wall');
}

export function showTenantSelect() {
  stopPolling();
  stopSystemPolling();
  store.page = 'tenant-select';
}

function showForbidden(message) {
  stopPolling();
  store.forbiddenMessage = message || 'このテナントを操作する権限がありません。';
  store.page = 'forbidden';
}

export function showSystemAdmin() {
  stopPolling();
  store.page = 'system-admin';
  startSystemPolling();
}

/** テナント選択画面から呼ばれる: 選んだテナントの管理画面へ移動する。 */
export function openTenant(id) {
  location.href = '/e/' + encodeURIComponent(id) + '/admin';
}

/**
 * 認証確認後の画面遷移。
 * single: 唯一のテナントへそのまま入る。
 * multi + URL にテナント指定あり: そのテナントを開こうとし、権限が無ければ
 *   forbidden 画面を出す (壊れた表示にはしない)。
 * multi + テナント指定なし: テナント選択画面を出す。
 */
async function routeAfterAuth(routeTenant) {
  if (store.mode === 'single') {
    setTenantPrefix('');
    store.tenantId = store.tenants[0]?.id || '';
    store.myRole = store.tenants[0]?.role || 'owner';
    connect();
    return;
  }

  if (!routeTenant) {
    showTenantSelect();
    return;
  }

  setTenantPrefix('/e/' + routeTenant);
  store.tenantId = routeTenant;
  const match = store.tenants.find((t) => t.id === routeTenant);
  store.myRole = match ? match.role : null;

  try {
    const res = await apiFetch(tenantPath('/api/admin/state'));
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      showForbidden(
        (body && body.message) ||
          (res.status === 404
            ? 'テナントが見つかりません。'
            : 'このテナントを操作する権限がありません。')
      );
      return;
    }
    connect();
  } catch {
    showForbidden('サーバーに接続できません。');
  }
}

function readAuthError() {
  const params = new URLSearchParams(location.search);
  const err = params.get('error');
  if (!err) return '';
  history.replaceState(null, '', location.pathname);
  if (err === 'not_allowed') {
    return 'このアカウントは管理を許可されていません。主催者に追加を依頼してください。';
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
  const routeTenant = parseRouteTenant();
  const authenticated = await refreshMe();
  if (!authenticated) {
    showLogin();
    return;
  }
  await routeAfterAuth(routeTenant);
}

function connect() {
  showApp();
  startPolling();
}

/**
 * ログイン成功後の共通処理。/api/auth/me を取り直してから経路解決する。
 * トークンログインは single/multi どちらでも直リンクのテナントを尊重する。
 */
async function afterLogin() {
  const routeTenant = parseRouteTenant();
  await refreshMe();
  await routeAfterAuth(routeTenant);
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
    await afterLogin();
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
    // 認可から戻ったときに、今開いている管理画面 (テナント直リンクを含む) へ帰る。
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ handle, returnTo: location.pathname }),
    });
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
  stopSystemPolling();
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
    const res = await apiFetch(tenantPath('/api/admin/state') + query);
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

// ==========================================================
// 差分反映
// ==========================================================

/**
 * ポーリング結果はストアへ差分だけを書き込む。
 *
 * 取得したオブジェクトをそのまま代入すると、中身が前回と同じでも参照が
 * 変わるため、その値を読んでいる全てのコンポーネント (入力欄を含む) が
 * 3 秒ごとに再描画され、入力途中の値が巻き戻る。実際に変わったフィールド
 * だけを書き換えることで、再描画の範囲を変更のあった領域に限定する。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

/** 既存オブジェクトを維持したまま、変わったキーだけを書き換える。 */
function patchObject(target, next) {
  for (const key of Object.keys(next)) {
    const nextValue = next[key];
    const current = target[key];
    if (Array.isArray(nextValue) && Array.isArray(current)) {
      patchList(current, nextValue);
    } else if (isPlainObject(nextValue) && isPlainObject(current)) {
      patchObject(current, nextValue);
    } else if (!sameValue(current, nextValue)) {
      target[key] = nextValue;
    }
  }
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete target[key];
  }
}

/**
 * 配列を要素単位で差分反映する。keyOf を渡すと、並び替えや削除があっても
 * 同じ要素は同じオブジェクトのまま扱えるため、無関係な行が再描画されない。
 */
function patchList(target, next, keyOf = null) {
  const byKey = new Map();
  if (keyOf) {
    for (const item of target) {
      const key = keyOf(item);
      if (key != null && !byKey.has(key)) byKey.set(key, item);
    }
  }
  for (let i = 0; i < next.length; i++) {
    const nextItem = next[i];
    let existing = null;
    if (keyOf && isPlainObject(nextItem)) {
      const key = keyOf(nextItem);
      if (key != null) existing = byKey.get(key) || null;
    } else if (isPlainObject(nextItem) && isPlainObject(target[i])) {
      existing = target[i];
    }
    if (existing && isPlainObject(nextItem)) {
      patchObject(existing, nextItem);
      if (target[i] !== existing) target[i] = existing;
    } else if (!sameValue(target[i], nextItem)) {
      target[i] = nextItem;
    }
  }
  if (target.length !== next.length) target.length = next.length;
}

/** 配列フィールドを差分反映する (中身が同じなら書き込まない)。 */
function patchArrayField(key, next, keyOf = null) {
  patchList(store[key], next || [], keyOf);
}

/** オブジェクトフィールドを差分反映する (null との行き来だけは代入する)。 */
function patchObjectField(key, next) {
  if (!isPlainObject(next) || !isPlainObject(store[key])) {
    if (!sameValue(store[key], next)) store[key] = next;
    return;
  }
  patchObject(store[key], next);
}

function renderState(data) {
  const state = data.state || {};
  patchObject(store.state, state);
  serverStartedAt = (state.stats && state.stats.startedAt) || 0;
  store.uptimeText = formatUptime(serverStartedAt);

  const postKey = (p) => (p ? p.uri : null);
  patchArrayField('walls', data.walls, (w) => (w ? w.id : null));
  patchArrayField('modLists', data.modLists, (l) => (l ? l.uri : null));
  patchArrayField('hidden', data.hidden, postKey);
  patchArrayField('blocked', data.blocked);
  patchArrayField('jetstreamHosts', data.jetstreamHosts);
  patchArrayField('pending', data.pending, postKey);
  patchArrayField('recent', data.recent, postKey);
  if (data.settings) patchObject(store.settings, data.settings);

  renderBackfillStatus(data.backfill);
  setAppviewUrl(data.appviewUrl);
  refreshSessionInfo();
}

function renderBackfillStatus(status) {
  if (!status) {
    store.backfill = null;
    return;
  }
  if (isPlainObject(store.backfill)) {
    patchObject(store.backfill, status);
    status = store.backfill;
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

export async function createWall(name, terms, backfillMinutes) {
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
    const res = await apiFetch(tenantPath('/api/admin/walls'), {
      method: 'POST',
      body: JSON.stringify({
        name: trimmedName,
        terms: terms.map((t) => ({
          value: t.value,
          type: t.type,
          requireApproval: t.requireApproval || 'inherit',
        })),
        ...(backfillMinutes ? { backfillMinutes } : {}),
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
    const res = await apiFetch(tenantPath('/api/admin/walls/' + encodeURIComponent(wall.id)), {
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
      const res = await apiFetch(tenantPath('/api/admin/walls/' + encodeURIComponent(wall.id)), { method: 'DELETE' });
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
  return { term: { value, type, requireApproval: 'inherit' } };
}

export async function saveTerms(terms, successMessage) {
  const payload = terms.map((t) => ({
    value: t.value,
    type: t.type,
    requireApproval: t.requireApproval || 'inherit',
  }));
  try {
    await callAdminApi(tenantPath('/api/admin/terms'), { terms: payload, wall: store.currentWallId || undefined });
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

/** 監視語ごとの承認要否を変更する。'inherit' | 'always' | 'never'。 */
export function setTermApproval(term, requireApproval) {
  const currentTerms = store.state.terms || [];
  const next = currentTerms.map((t) =>
    t.value === term.value && t.type === term.type ? { ...t, requireApproval } : t
  );
  return saveTerms(next, APPROVAL_LABELS[requireApproval] + ' に変更しました');
}

export const APPROVAL_LABELS = {
  inherit: 'ウォールの設定に従う',
  always: '必ず承認待ちにする',
  never: '承認なしで表示する',
};

export const WALL_MODERATION_LABELS = {
  inherit: 'テナントの設定に従う',
  open: '公開 (承認なしで表示)',
  approve: '承認制 (すべて承認待ち)',
};

export const WALL_KEYWORD_APPROVAL_LABELS = {
  inherit: 'テナントの設定に従う',
  always: '承認待ちにする',
  never: 'そのまま表示する',
};

export const EXCLUDE_POLICY_LABELS = {
  reject: '自動で非承認',
  approve: '承認待ちに回す',
};

/**
 * 除外キーワードを差し替える。
 * ネガティブワードそのものは会場モニターへ配らないため、ウォール一覧
 * (store.walls) から読み、更新もこの API だけで行う。
 */
export async function saveExcludeTerms(terms, successMessage) {
  return postExclude({ terms: terms.map((t) => ({ value: t.value })) }, successMessage);
}

export function addExcludeTerm(wall, raw) {
  const value = (raw || '').trim();
  if (!value) {
    showToast('除外する語を入力してください');
    return false;
  }
  if (value.length < 2) {
    showToast('除外キーワードは 2 文字以上で指定してください');
    return false;
  }
  const current = (wall && wall.excludeTerms) || [];
  if (current.some((t) => t.value.toLowerCase() === value.toLowerCase())) {
    showToast('すでに登録されています');
    return false;
  }
  saveExcludeTerms(current.concat([{ value }]), '除外キーワードに追加しました');
  return true;
}

export function requestRemoveExcludeTerm(wall, term) {
  openConfirm('除外キーワード「' + term.value + '」を外します。よろしいですか？', () => {
    const current = (wall && wall.excludeTerms) || [];
    saveExcludeTerms(
      current.filter((t) => t.value !== term.value),
      '除外キーワードから外しました'
    );
  });
}

export function setExcludePolicy(policy) {
  return postExclude({ policy }, '除外キーワードの扱いを変更しました');
}

async function postExclude(body, successMessage) {
  try {
    await callAdminApi(tenantPath('/api/admin/exclude'), {
      ...body,
      wall: store.currentWallId || undefined,
    });
    showToast(successMessage);
    await fetchState();
    return true;
  } catch {
    showToast('除外キーワードを更新できませんでした');
    return false;
  }
}

/**
 * いまのアカウントがテナントの設定を変えられるか。
 *
 * モデレーターは「流れている投稿への判断」と「進行に合わせた切り替え」だけを担う。
 * 監視語・除外・受信・表示・メンバーなどの設定はオーナー (とシステム管理者) のもの。
 * サーバー側でも同じ線で弾いているので、ここは画面を絞るためだけに使う。
 */
export function canEditSettings() {
  return store.myRole === 'owner' || store.myRole === 'system';
}

/**
 * ウォール配下のセクション。ナビ (WallTabs) と本体 (WallPanel) で同じ id を使う。
 * 別々に並べると、ずれたときにセクションが空で表示される (実際に起きた)。
 */
export const WALL_SECTIONS = [
  // ownerOnly のセクションはモデレーターには出さない (見ても操作できないため)。
  { id: 'ops', label: '承認待ち / 直近' },
  { id: 'terms', label: '監視語' },
  { id: 'monitor', label: '会場モニター' },
  { id: 'moderation', label: '承認と除外', ownerOnly: true },
  { id: 'manage', label: 'ウォール管理', ownerOnly: true },
];

export const SCREEN_MODE_LABELS = {
  wall: '通常 (投稿を流す)',
  waiting: '待機',
  break: '休憩',
  ended: '終演',
};

export const IMAGE_POSITION_LABELS = {
  'bottom-right': '右下',
  'bottom-center': '中央下',
  'bottom-left': '左下',
  center: '見出しの下 (中央)',
};

export const IMAGE_SIZE_LABELS = {
  small: '小 (画面高の 12%)',
  medium: '中 (18%)',
  large: '大 (26%)',
};

/** 会場モニターの画面モード・文言を更新する。 */
export async function setScreen(patch, successMessage) {
  try {
    await callAdminApi(tenantPath('/api/admin/screen'), {
      screen: patch,
      wall: store.currentWallId || undefined,
    });
    if (successMessage) showToast(successMessage);
    await fetchState();
    return true;
  } catch {
    showToast('画面モードを変更できませんでした');
    return false;
  }
}

/** 任意画像 (QR など) をアップロードする。読み込みはブラウザ側で行う。 */
export async function uploadScreenImage(file) {
  if (!file) return false;
  if (file.size > 2 * 1024 * 1024) {
    showToast('画像は 2 MB までです');
    return false;
  }
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type)) {
    showToast('画像は PNG / JPEG / WebP で指定してください');
    return false;
  }
  try {
    const data = await readFileAsBase64(file);
    await callAdminApi(tenantPath('/api/admin/screen/image'), {
      wall: store.currentWallId || undefined,
      mime: file.type,
      data,
    });
    showToast('画像を設定しました');
    await fetchState();
    return true;
  } catch {
    showToast('画像を設定できませんでした');
    return false;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function requestRemoveScreenImage() {
  openConfirm('設定した画像を削除します。よろしいですか？', async () => {
    try {
      const query = store.currentWallId ? '?wall=' + encodeURIComponent(store.currentWallId) : '';
      const res = await apiFetch(tenantPath('/api/admin/screen/image') + query, { method: 'DELETE' });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error('request failed');
      showToast('画像を削除しました');
      await fetchState();
    } catch {
      showToast('画像を削除できませんでした');
    }
  });
}

// ==========================================================
// システム管理: 利用者アカウント
// ==========================================================

export async function loadSystemAccounts() {
  try {
    const res = await apiFetch('/api/admin/system/accounts');
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    patchArrayField('systemAccounts', await withProfiles(data.accounts), (a) => (a ? a.did : null));
    store.systemAdminEditable = !!data.systemAdminEditable;
  } catch {
    showToast('アカウントを取得できませんでした');
  }
}

export async function setAccountMembership(account, tenantId, role) {
  try {
    await callAdminApi('/api/admin/system/accounts/membership', {
      tenantId,
      did: account.did,
      handle: account.handle,
      role,
    });
    showToast('所属を変更しました');
    await loadSystemAccounts();
    return true;
  } catch {
    showToast('所属を変更できませんでした');
    return false;
  }
}

export function requestRemoveMembership(account, membership) {
  openConfirm(
    'テナント「' + membership.tenantName + '」から「' + account.handle + '」を外します。よろしいですか？',
    async () => {
      try {
        const path =
          '/api/admin/system/accounts/membership/' +
          encodeURIComponent(membership.tenantId) +
          '/' +
          encodeURIComponent(account.did);
        const res = await apiFetch(path, { method: 'DELETE' });
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          showToast((body && body.message) || '所属を解除できませんでした');
          return;
        }
        showToast('所属を解除しました');
        await loadSystemAccounts();
      } catch {
        showToast('所属を解除できませんでした');
      }
    }
  );
}

export function requestRevokeAccountSessions(account) {
  openConfirm('「' + account.handle + '」のログインをすべて失効させます。よろしいですか？', async () => {
    try {
      await callAdminApi('/api/admin/system/accounts/' + encodeURIComponent(account.did) + '/revoke');
      showToast('セッションを失効しました');
      await loadSystemAccounts();
    } catch {
      showToast('セッションを失効できませんでした');
    }
  });
}

/** テナント共通の設定 (会場モニターの見た目) を更新する。 */
export async function updateTenantSettings(patch) {
  try {
    const res = await apiFetch(tenantPath('/api/admin/settings'), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      showToast((body && body.message) || '設定を変更できませんでした');
      return false;
    }
    showToast('設定を変更しました');
    await fetchState();
    return true;
  } catch {
    showToast('設定を変更できませんでした');
    return false;
  }
}

/** ウォールの表示設定 (会場モニター側の見た目) を更新する。 */
export async function updateWallDisplay(wallId, patch) {
  return updateWallSettings(wallId, { display: patch }, '表示設定を変更しました');
}

/** ウォール単位の承認設定を更新する。patch は moderationMode / keywordRequireApproval。 */
export async function updateWallModeration(wallId, patch) {
  return updateWallSettings(wallId, patch, '承認設定を変更しました');
}

/** ウォール設定 (PATCH /api/admin/walls/:id) の共通処理。 */
async function updateWallSettings(wallId, patch, successMessage) {
  try {
    const res = await apiFetch(tenantPath('/api/admin/walls/' + encodeURIComponent(wallId)), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      showToast((body && body.message) || '設定を変更できませんでした');
      return false;
    }
    showToast(successMessage);
    await fetchState();
    return true;
  } catch {
    showToast('設定を変更できませんでした');
    return false;
  }
}

// ==========================================================
// 投稿の操作
// ==========================================================

export async function approvePost(uri) {
  try {
    await callAdminApi(tenantPath('/api/admin/approve'), { uri, wall: store.currentWallId || undefined });
    await fetchState();
  } catch {
    showToast('承認に失敗しました');
  }
}

export async function hidePost(uri) {
  try {
    await callAdminApi(tenantPath('/api/admin/hide'), { uri });
    await fetchState();
  } catch {
    showToast('非表示処理に失敗しました');
  }
}

export async function unhidePost(uri) {
  try {
    await callAdminApi(tenantPath('/api/admin/unhide'), { uri });
    await fetchState();
  } catch {
    showToast('復元に失敗しました');
  }
}

export async function blockActor(did) {
  try {
    await callAdminApi(tenantPath('/api/admin/block'), { did });
    await fetchState();
  } catch {
    showToast('ブロックに失敗しました');
  }
}

export async function unblockActor(did) {
  try {
    await callAdminApi(tenantPath('/api/admin/unblock'), { did });
    await fetchState();
  } catch {
    showToast('ブロック解除に失敗しました');
  }
}

export async function clearAll() {
  try {
    await callAdminApi(tenantPath('/api/admin/clear'), { wall: store.currentWallId || undefined });
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
    await callAdminApi(tenantPath('/api/admin/pause'), { paused: nextPaused });
    store.state.paused = nextPaused;
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
    await callAdminApi(tenantPath('/api/admin/jetstream'), { host });
    showToast('接続先を切り替えました: ' + host);
    await fetchState();
  } catch {
    showToast('切り替えに失敗しました');
  }
}

/**
 * 過去の投稿を取り込む。
 * wallId を渡すとそのウォールだけに反映する (空なら全ウォール)。
 */
export async function runBackfill(minutes, wallId) {
  if (!minutes || minutes < 1) {
    showToast('遡る時間を選んでください');
    return false;
  }
  const body = { minutes };
  if (wallId) body.wall = wallId;
  try {
    await callAdminApi(tenantPath('/api/admin/backfill'), body);
    showToast('取り込みを開始しました');
    await fetchState();
    return true;
  } catch {
    showToast('取り込みを開始できませんでした');
    return false;
  }
}

export async function loadAvailableModlists(actor) {
  const path = tenantPath('/api/admin/modlists/available') + (actor ? '?actor=' + encodeURIComponent(actor) : '');
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
    const res = await callAdminApi(tenantPath('/api/admin/modlists'), { uri });
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
    const res = await apiFetch(tenantPath('/api/admin/modlists'), {
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

// ==========================================================
// メンバー管理 (テナントごと。owner とシステム管理者のみ画面に出す)
// ==========================================================

export async function loadMembers() {
  try {
    const res = await apiFetch(tenantPath('/api/admin/members'));
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) {
      patchArrayField('members', []);
      return;
    }
    const data = await res.json();
    patchArrayField('members', await withProfiles(data.members), (m) => (m ? m.did : null));
  } catch {
    showToast('メンバー一覧を取得できませんでした');
  }
}

export async function addMember(actor, role) {
  const trimmed = (actor || '').trim();
  if (!trimmed) {
    showToast('ハンドルまたは DID を入力してください');
    return false;
  }
  try {
    const res = await apiFetch(tenantPath('/api/admin/members'), {
      method: 'POST',
      body: JSON.stringify({ actor: trimmed, role }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!res.ok) {
      // サーバーのメッセージ (例: オーナーが 0 人になる、など) をそのまま見せる。
      const body = await res.json().catch(() => null);
      showToast((body && body.message) || 'メンバーを追加できませんでした');
      return false;
    }
    showToast('メンバーを追加しました');
    await loadMembers();
    return true;
  } catch {
    showToast('メンバーを追加できませんでした');
    return false;
  }
}

export async function updateMemberRole(did, role) {
  try {
    const res = await apiFetch(tenantPath('/api/admin/members/' + encodeURIComponent(did)), {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      showToast((body && body.message) || '役割を変更できませんでした');
      return false;
    }
    showToast('役割を変更しました');
    await loadMembers();
    return true;
  } catch {
    showToast('役割を変更できませんでした');
    return false;
  }
}

export function requestRemoveMember(member) {
  openConfirm('メンバー「' + member.handle + '」を削除します。よろしいですか？', async () => {
    try {
      const res = await apiFetch(tenantPath('/api/admin/members/' + encodeURIComponent(member.did)), {
        method: 'DELETE',
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast((body && body.message) || 'メンバーを削除できませんでした');
        return;
      }
      showToast('メンバーを削除しました');
      await loadMembers();
    } catch {
      showToast('メンバーを削除できませんでした');
    }
  });
}

// ==========================================================
// システム管理 (multi のみ。isSystemAdmin だけが実行できる)
// ==========================================================
// このセクションの API はすべてテナントに属さない (常にルート直下)。
// tenantPath() を使わないこと。

export function startSystemPolling() {
  stopSystemPolling();
  loadSystemOverview();
  loadSystemTenants();
  systemPollTimer = setInterval(() => {
    loadSystemOverview();
    loadSystemTenants();
  }, SYSTEM_POLL_INTERVAL_MS);
}

export function stopSystemPolling() {
  if (systemPollTimer) {
    clearInterval(systemPollTimer);
    systemPollTimer = null;
  }
}

export async function loadSystemOverview() {
  try {
    const res = await apiFetch('/api/admin/system/overview');
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) return;
    const overview = await res.json();
    setAppviewUrl(overview.appviewUrl);
    patchObjectField('systemOverview', overview);
  } catch {
    // 無視。次のポーリングで再取得を試みる。
  }
}

export async function loadSystemTenants() {
  try {
    const res = await apiFetch('/api/admin/system/tenants');
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    patchArrayField('systemTenants', data.tenants, (t) => (t ? t.id : null));
  } catch {
    // 無視。次のポーリングで再取得を試みる。
  }
}

export async function loadSystemAudit() {
  try {
    const res = await apiFetch('/api/admin/system/audit');
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    store.systemAudit = data.entries || [];
  } catch {
    showToast('監査ログを取得できませんでした');
  }
}

export async function createSystemTenant(id, name, ownerActor) {
  const trimmedId = (id || '').trim();
  const trimmedName = (name || '').trim();
  const trimmedOwner = (ownerActor || '').trim();
  if (!trimmedId || !trimmedName || !trimmedOwner) {
    showToast('ID / 名前 / オーナーをすべて入力してください');
    return false;
  }
  try {
    const res = await apiFetch('/api/admin/system/tenants', {
      method: 'POST',
      body: JSON.stringify({ id: trimmedId, name: trimmedName, ownerActor: trimmedOwner }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      showToast((body && body.message) || 'テナントを作成できませんでした');
      return false;
    }
    showToast('テナント「' + trimmedName + '」を作成しました');
    await loadSystemTenants();
    await loadSystemOverview();
    return true;
  } catch {
    showToast('テナントを作成できませんでした');
    return false;
  }
}

export function requestDeleteSystemTenant(tenant) {
  openConfirm(
    'テナント「' + tenant.name + '」を削除します。ウォールと投稿もすべて失われます。よろしいですか？',
    async () => {
      try {
        const res = await apiFetch('/api/admin/system/tenants/' + encodeURIComponent(tenant.id), {
          method: 'DELETE',
        });
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!res.ok) {
          showToast('削除に失敗しました');
          return;
        }
        showToast('テナント「' + tenant.name + '」を削除しました');
        await loadSystemTenants();
        await loadSystemOverview();
      } catch {
        showToast('削除に失敗しました');
      }
    }
  );
}

export async function switchSystemJetstream(host) {
  if (!host) return;
  try {
    const res = await apiFetch('/api/admin/system/jetstream', {
      method: 'POST',
      body: JSON.stringify({ host }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      showToast((body && body.message) || '切り替えに失敗しました');
      return;
    }
    showToast('接続先を切り替えました: ' + host);
    await loadSystemOverview();
  } catch {
    showToast('切り替えに失敗しました');
  }
}
