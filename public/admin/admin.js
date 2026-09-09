/**
 * Bluesky Live Wall - 管理画面ロジック
 * ビルドツール不使用。素の JavaScript のみ。外部 CDN には依存しない。
 *
 * API 契約 (docs/task-breakdown.md):
 *   GET  /api/admin/state   -> { state: WallState, recent: WallPost[], pending: WallPost[] }
 *   POST /api/admin/pause   body { paused: boolean }
 *   POST /api/admin/hide    body { uri: string }
 *   POST /api/admin/approve body { uri: string }
 *   POST /api/admin/block   body { did: string }
 *   POST /api/admin/clear   (body なし)
 * すべて Authorization: Bearer <ADMIN_TOKEN> を付与する。
 */

(function () {
  'use strict';

  // ---------- 定数 ----------
  // トークンは保存しない。ログイン時に一度だけ送り、以降は HttpOnly Cookie の
  // セッションで認証する。localStorage にトークンを残さないための設計。
  var STORAGE_THEME_KEY = 'bsky_live_wall_admin_theme';
  var STORAGE_WALL_KEY = 'bsky_live_wall_admin_wall_id';
  var POLL_INTERVAL_MS = 3000;
  var CONFIRM_TIMEOUT_MS = 3000;
  var MAX_WALLS = 10;

  // ---------- DOM 参照 ----------
  var el = {
    toast: document.getElementById('toast'),
    pauseBanner: document.getElementById('pause-banner'),

    loginScreen: document.getElementById('login-screen'),
    tokenInput: document.getElementById('token-input'),
    loginError: document.getElementById('login-error'),
    connectBtn: document.getElementById('connect-btn'),
    clearTokenBtn: document.getElementById('clear-token-btn'),

    app: document.getElementById('app'),
    openWallBtn: document.getElementById('open-wall-btn'),
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    logoutBtn: document.getElementById('logout-btn'),

    jsConnected: document.getElementById('js-connected'),
    jsHost: document.getElementById('js-host'),
    jsReconnects: document.getElementById('js-reconnects'),
hiddenList: document.getElementById('hidden-list'),
hiddenCount: document.getElementById('hidden-count'),
hiddenEmpty: document.getElementById('hidden-empty'),
blockedList: document.getElementById('blocked-list'),
blockedCount: document.getElementById('blocked-count'),
blockedEmpty: document.getElementById('blocked-empty'),
sessionCount: document.getElementById('session-count'),
sessionExpiry: document.getElementById('session-expiry'),
revokeSessionsBtn: document.getElementById('revoke-sessions-btn'),
termInput: document.getElementById('term-input'),
termAddBtn: document.getElementById('term-add-btn'),
termKeywordCheck: document.getElementById('term-keyword-check'),
termList: document.getElementById('term-list'),
termEmpty: document.getElementById('term-empty'),
keywordWarning: document.getElementById('keyword-warning'),
keywordWarningText: document.getElementById('keyword-warning-text'),
confirmDialog: document.getElementById('confirm-dialog'),
confirmMessage: document.getElementById('confirm-message'),
confirmOk: document.getElementById('confirm-ok'),
jetstreamSelect: document.getElementById('jetstream-select'),
jetstreamSwitchBtn: document.getElementById('jetstream-switch-btn'),
modlistCount: document.getElementById('modlist-count'),
modlistSubscribed: document.getElementById('modlist-subscribed'),
modlistEmpty: document.getElementById('modlist-empty'),
modlistActorInput: document.getElementById('modlist-actor-input'),
modlistLoadBtn: document.getElementById('modlist-load-btn'),
modlistAvailable: document.getElementById('modlist-available'),
oauthLogin: document.getElementById('oauth-login'),
oauthBtn: document.getElementById('oauth-btn'),
handleInput: document.getElementById('handle-input'),
tokenLogin: document.getElementById('token-login'),
loginDivider: document.getElementById('login-divider'),
    hashtags: document.getElementById('hashtags'),
    modMode: document.getElementById('mod-mode'),
    uptime: document.getElementById('uptime'),

    statMatched: document.getElementById('stat-matched'),
    statDisplayed: document.getElementById('stat-displayed'),
    statRejected: document.getElementById('stat-rejected'),
    statAuthors: document.getElementById('stat-authors'),

    pauseToggle: document.getElementById('pause-toggle'),
    pauseToggleLabel: document.getElementById('pause-toggle-label'),
    clearAllBtn: document.getElementById('clear-all-btn'),

    pendingPanel: document.getElementById('pending-panel'),
    pendingList: document.getElementById('pending-list'),
    pendingEmpty: document.getElementById('pending-empty'),
    pendingCount: document.getElementById('pending-count'),

    recentList: document.getElementById('recent-list'),
    recentEmpty: document.getElementById('recent-empty'),
    recentCount: document.getElementById('recent-count'),

    // ウォール切り替え
    wallSwitcher: document.getElementById('wall-switcher'),
    wallTabs: document.getElementById('wall-tabs'),

    // ウォール単位の表示ラベル
    statusWallName: document.getElementById('status-wall-name'),
    clearWallName: document.getElementById('clear-wall-name'),
    watchWallName: document.getElementById('watch-wall-name'),
    pendingWallName: document.getElementById('pending-wall-name'),
    recentWallName: document.getElementById('recent-wall-name'),

    // ウォール管理パネル
    wallManageList: document.getElementById('wall-manage-list'),
    wallManageCount: document.getElementById('wall-manage-count'),
    wallNewNameInput: document.getElementById('wall-new-name-input'),
    wallNewTermInput: document.getElementById('wall-new-term-input'),
    wallNewTermAddBtn: document.getElementById('wall-new-term-add-btn'),
    wallNewTermKeywordCheck: document.getElementById('wall-new-term-keyword-check'),
    wallNewTermList: document.getElementById('wall-new-term-list'),
    wallNewTermEmpty: document.getElementById('wall-new-term-empty'),
    wallCreateBtn: document.getElementById('wall-create-btn'),
    wallLimitNote: document.getElementById('wall-limit-note'),
  };

  // ---------- 状態 ----------
  var pollTimer = null;
  var currentToken = '';
  var sessionExpiresAt = 0;
  // サーバーが受け付ける認証方式。エラーメッセージの出し分けに使う。
  var authConfig = { token: true, oauth: false };
  var isPaused = false;
  var pauseRequestInFlight = false;

  // 選択中のウォール。空文字は「既定ウォール」を意味する。
  // 解決後 (state.wallId を受け取った後) は具体的な ID に置き換える。
  var currentWallId = loadWallId();
  // 直近に取得したウォール一覧 (ウォール管理パネルの再描画や上限判定に使う)。
  var lastWalls = [];
  // ウォール管理パネルで改名フォームを開いているウォール ID (null なら非表示)。
  var renamingWallId = null;
  // ウォール新規作成フォームで積んでいる監視語。
  var newWallTerms = [];

  function loadWallId() {
    try {
      return localStorage.getItem(STORAGE_WALL_KEY) || '';
    } catch (e) {
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
    } catch (e) {
      // 無視。保存できなくても動作に支障はない。
    }
  }

  // ==========================================================
  // トークン管理
  // ==========================================================

  function loadToken() {
    return '';
  }

  function saveToken() {
    // 何もしない。トークンは保存しない。
  }

  function removeToken() {
    try {
      // 過去のバージョンが保存したトークンがあれば消しておく。
      localStorage.removeItem('bsky_live_wall_admin_token');
    } catch (e) {
      // 無視
    }
  }

  // ==========================================================
  // テーマ管理
  // ==========================================================

  function loadTheme() {
    try {
      return localStorage.getItem(STORAGE_THEME_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    updateThemeIcon();
  }

  // 現在のテーマを示すアイコンに差し替える (暗いとき月、明るいとき太陽)。
  function updateThemeIcon() {
    var iconEl = document.getElementById('theme-icon');
    if (!iconEl) return;
    var attr = document.documentElement.getAttribute('data-theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = attr ? attr === 'dark' : prefersDark;
    iconEl.className = (isDark ? 'fa-solid fa-moon' : 'fa-solid fa-sun') + ' fa-fw';
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var effectiveCurrent = current || (prefersDark ? 'dark' : 'light');
    var next = effectiveCurrent === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_THEME_KEY, next);
    } catch (e) {
      // 無視
    }
  }

  applyTheme(loadTheme());

  // ==========================================================
  // トースト通知 (ネットワークエラー等)
  // ==========================================================

  var toastHideTimer = null;

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
    }
    toastHideTimer = setTimeout(function () {
      el.toast.hidden = true;
    }, 4000);
  }

  // ==========================================================
  // API 通信
  // ==========================================================

  /**
   * 認証ヘッダ付きで fetch する。
   * 401 の場合は onUnauthorized コールバックを呼ぶ。
   * ネットワークエラーの場合は例外を投げる (呼び出し側でトースト表示する)。
   */
  function apiFetch(path, options) {
    options = options || {};
    var headers = options.headers || {};
    // 認証は HttpOnly Cookie。CSRF 対策としてカスタムヘッダを付ける
    // (クロスオリジンからはプリフライトなしに付与できない)。
    headers['X-Requested-With'] = 'bsky-live-wall';
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
      // セッション Cookie を必ず送る。
      credentials: 'same-origin',
    });
  }

  // 401 は「トークンが違う」とは限らない。セッション切れ・失効・方式変更でも起きる。
  // トークン入力の失敗は入力時に個別のメッセージを出しているので、ここでは扱わない。
  function handleUnauthorized() {
    stopPolling();
    removeToken();
    currentToken = '';
    sessionExpiresAt = 0;
    showLogin(
      authConfig.oauth && !authConfig.token
        ? 'セッションの有効期限が切れました。もう一度ログインしてください。'
        : 'セッションが無効になりました。もう一度ログインしてください。'
    );
  }

  // ==========================================================
  // 画面切り替え
  // ==========================================================

  function showLogin(errorMessage) {
    el.app.hidden = true;
    el.loginScreen.hidden = false;
    el.pauseBanner.hidden = true;
    if (errorMessage) {
      el.loginError.textContent = errorMessage;
      el.loginError.hidden = false;
    } else {
      el.loginError.hidden = true;
    }
    el.tokenInput.value = '';
    el.tokenInput.focus();
  }

  function showApp() {
    el.loginScreen.hidden = true;
    el.app.hidden = false;
  }

  // ==========================================================
  // 状態ポーリング
  // ==========================================================

  function startPolling() {
    stopPolling();
    fetchState();
    pollTimer = setInterval(fetchState, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function fetchState() {
    // リクエスト発行時点のウォール ID を覚えておく。応答が返るまでの間に
    // 別のウォールへ切り替えられた場合、古い応答で表示を巻き戻さないため。
    var requestedWallId = currentWallId;
    var query = requestedWallId ? '?wall=' + encodeURIComponent(requestedWallId) : '';
    return apiFetch('/api/admin/state' + query)
      .then(function (res) {
        if (res.status === 401) {
          handleUnauthorized();
          return null;
        }
        if (res.status === 404) {
          // 保存されていたウォール ID が存在しない (削除された等)。既定へ戻す。
          if (requestedWallId) {
            currentWallId = '';
            saveWallId('');
            showToast('選択していたウォールが見つからないため、既定ウォールに戻しました');
            return fetchState();
          }
          throw new Error('wall not found');
        }
        if (!res.ok) {
          throw new Error('サーバーエラー (' + res.status + ')');
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (requestedWallId !== currentWallId) {
          // その間に選択ウォールが変わった。古い応答なので破棄する。
          return;
        }
        if (!currentWallId && data.state && data.state.wallId) {
          // 「既定ウォール」を解決した具体的な ID を覚えておく。
          currentWallId = data.state.wallId;
          saveWallId(currentWallId);
        }
        renderState(data);
      })
      .catch(function () {
        // ネットワークエラーはバナー通知のみ。ポーリングは止めない。
        showToast('通信エラー: 状態を取得できませんでした');
      });
  }

  // ==========================================================
  // 描画
  // ==========================================================

  function formatUptime(startedAt) {
    if (!startedAt) return '-';
    var sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return h + ':' + pad(m) + ':' + pad(s);
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    } catch (e) {
      return '-';
    }
  }

  function renderState(data) {
    var state = data.state || {};
    var jetstream = state.jetstream || {};
    var stats = state.stats || {};

    // Jetstream 接続状態
    if (jetstream.connected) {
      el.jsConnected.textContent = '接続中';
      el.jsConnected.className = 'status-value badge badge-ok';
    } else {
      el.jsConnected.textContent = '切断';
      el.jsConnected.className = 'status-value badge badge-error';
    }
    el.jsHost.textContent = jetstream.host || '-';
    el.jsReconnects.textContent = (jetstream.reconnects != null) ? String(jetstream.reconnects) : '-';

    // ハッシュタグ / モード
    el.hashtags.textContent = (state.hashtags && state.hashtags.length) ? state.hashtags.map(function (t) { return '#' + t; }).join(' ') : '-';
    el.modMode.textContent = state.moderationMode === 'approve' ? '承認モード' : '公開モード';
    el.uptime.textContent = formatUptime(stats.startedAt);

    // 統計
    el.statMatched.textContent = stats.matched != null ? stats.matched : 0;
    el.statDisplayed.textContent = stats.displayed != null ? stats.displayed : 0;
    el.statRejected.textContent = stats.rejected != null ? stats.rejected : 0;
    el.statAuthors.textContent = stats.authors != null ? stats.authors : 0;

    // 一時停止状態
    isPaused = !!state.paused;
    updatePauseUI();

    // 承認待ちパネルの表示切替 (approve モードのみ)
    var showPending = state.moderationMode === 'approve';
    el.pendingPanel.hidden = !showPending;

    renderPendingList(data.pending || []);
    renderRecentList(data.recent || []);
    renderHiddenList(data.hidden || []);
    renderBlockedList(data.blocked || []);
    renderWatchSettings(data);
    renderModLists(data.modLists || []);
    refreshSessionInfo();

    // ウォール単位の表示ラベルと、ウォール切り替え UI / 管理パネルの更新。
    var wallName = state.wallName || '-';
    el.statusWallName.textContent = wallName;
    el.clearWallName.textContent = wallName;
    el.watchWallName.textContent = wallName;
    el.pendingWallName.textContent = wallName;
    el.recentWallName.textContent = wallName;

    lastWalls = data.walls || [];
    renderWallTabs(lastWalls, state.wallId);
    // 改名フォームを開いている間は再描画で入力内容が消えてしまうため、
    // 一覧の再構築を止める (フォームを閉じたときに最新の内容へ更新される)。
    if (renamingWallId === null) {
      renderWallManageList(lastWalls, state.wallId);
    }
    updateWallCreateAvailability(lastWalls.length);
  }

  function updatePauseUI() {
    el.pauseToggle.setAttribute('aria-pressed', isPaused ? 'true' : 'false');
    el.pauseToggleLabel.textContent = isPaused ? '停止中' : '稼働中';
    el.pauseBanner.hidden = !isPaused;
  }

  function renderPendingList(posts) {
    el.pendingCount.textContent = String(posts.length);
    el.pendingList.innerHTML = '';
    el.pendingEmpty.hidden = posts.length > 0;
    posts.forEach(function (post) {
      el.pendingList.appendChild(buildPostItem(post, { approve: true, hide: true, block: true }));
    });
  }

  function renderRecentList(posts) {
    el.recentCount.textContent = String(posts.length);
    el.recentList.innerHTML = '';
    el.recentEmpty.hidden = posts.length > 0;
    posts.forEach(function (post) {
      el.recentList.appendChild(buildPostItem(post, { approve: false, hide: true, block: true }));
    });
  }

  // 監視設定。
  function renderWatchSettings(data) {
    var state = data.state || {};
    renderTerms(state.terms || []);

    var hosts = data.jetstreamHosts || [];
    var current = (state.jetstream && state.jetstream.host) || '';
    // 候補が変わっていなければ再構築しない (選択状態を壊さないため)。
    if (el.jetstreamSelect.options.length !== hosts.length) {
      el.jetstreamSelect.replaceChildren();
      hosts.forEach(function (host) {
        var opt = document.createElement('option');
        opt.value = host;
        opt.textContent = host;
        el.jetstreamSelect.appendChild(opt);
      });
    }
    if (current && document.activeElement !== el.jetstreamSelect) {
      el.jetstreamSelect.value = current;
    }
  }

  // 監視対象をラベル (チップ) として並べる。× で個別に外せる。
  var currentTerms = [];
  function renderTerms(terms) {
    currentTerms = terms;
    el.termList.replaceChildren();
    el.termEmpty.hidden = terms.length > 0;

    var keywordCount = 0;
    terms.forEach(function (term) {
      if (term.type === 'keyword') keywordCount += 1;

      var li = document.createElement('li');
      li.className = 'term-chip term-chip-' + term.type;

      var icon = document.createElement('i');
      icon.className = (term.type === 'hashtag' ? 'fa-solid fa-hashtag' : 'fa-solid fa-font');
      icon.setAttribute('aria-hidden', 'true');
      li.appendChild(icon);

      var label = document.createElement('span');
      label.className = 'term-label';
      label.textContent = term.value;
      li.appendChild(label);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'term-remove';
      remove.setAttribute(
        'aria-label',
        (term.type === 'hashtag' ? 'ハッシュタグ ' : 'キーワード ') + term.value + ' を削除'
      );
      remove.title = '削除';
      remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
      remove.addEventListener('click', function () { requestRemoveTerm(term); });
      li.appendChild(remove);

      el.termList.appendChild(li);
    });

    // キーワードが設定されているときは、扱いの違いを常に見えるようにする。
    el.keywordWarning.hidden = keywordCount === 0;
    if (keywordCount > 0) {
      el.keywordWarningText.textContent =
        'キーワード ' + keywordCount + ' 件が有効です。' +
        'ハッシュタグの付かない投稿は、イベントを知らない第三者のものである可能性があります。' +
        '既定ではキーワードのみ一致した投稿は承認待ちに入ります。';
    }
  }

  // 監視対象の削除は確認ダイアログを挟む。誤操作で監視が止まるのを防ぐため。
  function requestRemoveTerm(term) {
    var kind = term.type === 'hashtag' ? 'ハッシュタグ' : 'キーワード';
    openConfirm(kind + '「' + term.value + '」を監視対象から外します。よろしいですか？', function () {
      var next = currentTerms.filter(function (t) {
        return !(t.value === term.value && t.type === term.type);
      });
      if (next.length === 0) {
        showToast('監視対象を 0 件にはできません');
        return;
      }
      saveTerms(next, '監視対象から外しました');
    });
  }

  function saveTerms(terms, successMessage) {
    var payload = terms.map(function (t) { return { value: t.value, type: t.type }; });
    callAdminApi('/api/admin/terms', { terms: payload, wall: currentWallId || undefined })
      .then(function () {
        showToast(successMessage);
        fetchState();
      })
      .catch(function () { showToast('監視対象の更新に失敗しました'); });
  }

  // ==========================================================
  // ウォール切り替え / 管理
  // ==========================================================

  // 上部のウォール切り替えタブ。ウォールが 1 個のときは表示しない。
  function renderWallTabs(walls, activeId) {
    el.wallSwitcher.hidden = walls.length <= 1;
    el.wallTabs.replaceChildren();
    var activeTab = null;

    walls.forEach(function (w) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'wall-tab' + (w.pendingCount > 0 ? ' wall-tab-pending' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', w.id === activeId ? 'true' : 'false');

      var label = document.createElement('span');
      label.textContent = w.name;
      tab.appendChild(label);

      var countBadge = document.createElement('span');
      countBadge.className = 'wall-tab-count';
      var countText = w.postCount + ' 件';
      if (w.pendingCount > 0) countText += ' / 承認待ち ' + w.pendingCount;
      countBadge.textContent = countText;
      tab.appendChild(countBadge);

      tab.addEventListener('click', function () { switchWall(w.id); });
      el.wallTabs.appendChild(tab);

      if (w.id === activeId) activeTab = tab;
    });

    // タブが画面幅を超えている場合、選択中のタブが隠れないように寄せる。
    // ポーリングのたびに毎回動かすと目障りなので、実際に見えていないときだけ。
    if (activeTab && isTabOutOfView(activeTab)) {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /** タブがスクロール領域からはみ出しているか。 */
  function isTabOutOfView(tab) {
    var box = el.wallTabs.getBoundingClientRect();
    var t = tab.getBoundingClientRect();
    return t.left < box.left || t.right > box.right;
  }

  // タブ列はホイールの縦回転でも横へ送れるようにする。
  // トラックパッドのない環境で、はみ出したタブへ到達できなくなるのを防ぐ。
  el.wallTabs.addEventListener(
    'wheel',
    function (evt) {
      if (evt.deltaX !== 0) return;
      if (el.wallTabs.scrollWidth <= el.wallTabs.clientWidth) return;
      evt.preventDefault();
      el.wallTabs.scrollLeft += evt.deltaY;
    },
    { passive: false }
  );

  // 選択中のウォールを切り替える。ウォール単位の API 呼び出しはすべて
  // currentWallId を参照するので、切り替えるだけで反映される。
  function switchWall(id) {
    if (!id || id === currentWallId) return;
    currentWallId = id;
    saveWallId(id);
    renamingWallId = null;
    fetchState();
  }

  // ウォール新規作成フォームが上限に達しているかどうかを反映する。
  function updateWallCreateAvailability(count) {
    var atLimit = count >= MAX_WALLS;
    el.wallLimitNote.hidden = !atLimit;
    el.wallNewNameInput.disabled = atLimit;
    el.wallNewTermInput.disabled = atLimit;
    el.wallNewTermAddBtn.disabled = atLimit;
    el.wallNewTermKeywordCheck.disabled = atLimit;
    el.wallCreateBtn.disabled = atLimit;
  }

  // ウォール管理パネルの一覧。名前 / ID / 監視語 / 件数 / 操作を並べる。
  function renderWallManageList(walls, activeId) {
    el.wallManageCount.textContent = String(walls.length);
    el.wallManageList.replaceChildren();

    walls.forEach(function (w) {
      var li = document.createElement('li');
      li.className = 'wall-manage-item' + (w.id === activeId ? ' is-current' : '');

      var main = document.createElement('div');
      main.className = 'wall-manage-main';

      if (renamingWallId === w.id) {
        main.appendChild(buildRenameForm(w));
      } else {
        var nameRow = document.createElement('div');
        nameRow.className = 'wall-manage-name';

        var nameSpan = document.createElement('span');
        nameSpan.textContent = w.name;
        nameRow.appendChild(nameSpan);

        var idSpan = document.createElement('span');
        idSpan.className = 'wall-manage-id';
        idSpan.textContent = w.id;
        nameRow.appendChild(idSpan);

        if (w.isDefault) {
          var defaultBadge = document.createElement('span');
          defaultBadge.className = 'wall-default-badge';
          defaultBadge.textContent = '既定';
          nameRow.appendChild(defaultBadge);
        }
        if (w.id === activeId) {
          var currentBadge = document.createElement('span');
          currentBadge.className = 'wall-default-badge';
          currentBadge.textContent = '選択中';
          nameRow.appendChild(currentBadge);
        }
        main.appendChild(nameRow);

        var termsLine = document.createElement('div');
        termsLine.className = 'wall-manage-terms';
        var termsText = (w.terms || [])
          .map(function (t) { return (t.type === 'hashtag' ? '#' : 'キーワード:') + t.value; })
          .join(' / ');
        termsLine.textContent = termsText || '(監視語なし)';
        main.appendChild(termsLine);
      }
      li.appendChild(main);

      var counts = document.createElement('div');
      counts.className = 'wall-manage-counts';
      var postBadge = document.createElement('span');
      postBadge.className = 'panel-count';
      postBadge.textContent = '表示 ' + w.postCount;
      counts.appendChild(postBadge);
      var pendingBadge = document.createElement('span');
      pendingBadge.className = 'panel-count';
      if (w.pendingCount > 0) pendingBadge.style.color = 'var(--color-warning)';
      pendingBadge.textContent = '承認待ち ' + w.pendingCount;
      counts.appendChild(pendingBadge);
      li.appendChild(counts);

      var actions = document.createElement('div');
      actions.className = 'wall-manage-actions';

      var openLink = document.createElement('a');
      openLink.className = 'btn btn-neutral btn-small';
      openLink.href = '/wall/' + encodeURIComponent(w.id);
      openLink.target = '_blank';
      openLink.rel = 'noopener';
      var openIcon = document.createElement('i');
      openIcon.className = 'fa-solid fa-up-right-from-square fa-fw';
      openIcon.setAttribute('aria-hidden', 'true');
      openLink.appendChild(openIcon);
      openLink.appendChild(document.createTextNode(' このウォールを開く'));
      actions.appendChild(openLink);

      if (w.id !== activeId) {
        var switchBtn = document.createElement('button');
        switchBtn.type = 'button';
        switchBtn.className = 'btn btn-primary btn-small';
        var switchIcon = document.createElement('i');
        switchIcon.className = 'fa-solid fa-arrow-right-to-bracket fa-fw';
        switchIcon.setAttribute('aria-hidden', 'true');
        switchBtn.appendChild(switchIcon);
        switchBtn.appendChild(document.createTextNode(' 切替'));
        switchBtn.addEventListener('click', function () { switchWall(w.id); });
        actions.appendChild(switchBtn);
      }

      if (renamingWallId !== w.id) {
        var renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'btn btn-neutral btn-small';
        var renameIcon = document.createElement('i');
        renameIcon.className = 'fa-solid fa-pen fa-fw';
        renameIcon.setAttribute('aria-hidden', 'true');
        renameBtn.appendChild(renameIcon);
        renameBtn.appendChild(document.createTextNode(' 改名'));
        renameBtn.addEventListener('click', function () {
          renamingWallId = w.id;
          renderWallManageList(lastWalls, activeId);
        });
        actions.appendChild(renameBtn);
      }

      // 既定ウォールは削除できない。ボタン自体を出さない。
      if (!w.isDefault) {
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-danger btn-small';
        var deleteIcon = document.createElement('i');
        deleteIcon.className = 'fa-solid fa-trash fa-fw';
        deleteIcon.setAttribute('aria-hidden', 'true');
        deleteBtn.appendChild(deleteIcon);
        deleteBtn.appendChild(document.createTextNode(' 削除'));
        deleteBtn.addEventListener('click', function () { requestDeleteWall(w); });
        actions.appendChild(deleteBtn);
      }

      li.appendChild(actions);
      el.wallManageList.appendChild(li);
    });
  }

  // 改名用のインラインフォーム。<dialog> や prompt は使わない。
  function buildRenameForm(wall) {
    var form = document.createElement('form');
    form.className = 'wall-manage-rename-form';

    var input = document.createElement('input');
    input.type = 'text';
    input.value = wall.name;
    input.setAttribute('aria-label', 'ウォール名');
    form.appendChild(input);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn btn-primary btn-small';
    var saveIcon = document.createElement('i');
    saveIcon.className = 'fa-solid fa-check fa-fw';
    saveIcon.setAttribute('aria-hidden', 'true');
    saveBtn.appendChild(saveIcon);
    form.appendChild(saveBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost btn-small';
    var cancelIcon = document.createElement('i');
    cancelIcon.className = 'fa-solid fa-xmark fa-fw';
    cancelIcon.setAttribute('aria-hidden', 'true');
    cancelBtn.appendChild(cancelIcon);
    cancelBtn.addEventListener('click', function () {
      renamingWallId = null;
      renderWallManageList(lastWalls, currentWallId);
    });
    form.appendChild(cancelBtn);

    form.addEventListener('submit', function (evt) {
      evt.preventDefault();
      submitRenameWall(wall, input.value);
    });

    // 変換確定の Enter で改名が確定しないようにする。
    bindEnter(input, function () {
      submitRenameWall(wall, input.value);
    });

    setTimeout(function () {
      input.focus();
      input.select();
    }, 0);

    return form;
  }

  function submitRenameWall(wall, newName) {
    newName = (newName || '').trim();
    if (!newName) {
      showToast('ウォール名を入力してください');
      return;
    }
    apiFetch('/api/admin/walls/' + encodeURIComponent(wall.id), {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    })
      .then(function (res) {
        if (res.status === 401) {
          handleUnauthorized();
          throw new Error('unauthorized');
        }
        if (!res.ok) throw new Error('request failed');
        return res.json();
      })
      .then(function () {
        renamingWallId = null;
        showToast('ウォール名を変更しました');
        fetchState();
      })
      .catch(function (err) {
        if (err && err.message === 'unauthorized') return;
        showToast('名前の変更に失敗しました');
      });
  }

  // 削除は既存の <dialog> 確認を使う。誤操作でウォールごと消えるのを防ぐため。
  function requestDeleteWall(wall) {
    openConfirm('ウォール「' + wall.name + '」を削除します。よろしいですか？ 表示中の投稿もすべて失われます。', function () {
      apiFetch('/api/admin/walls/' + encodeURIComponent(wall.id), { method: 'DELETE' })
        .then(function (res) {
          if (res.status === 401) {
            handleUnauthorized();
            throw new Error('unauthorized');
          }
          if (!res.ok) throw new Error('request failed');
          return res.json();
        })
        .then(function () {
          showToast('ウォール「' + wall.name + '」を削除しました');
          if (currentWallId === wall.id) {
            // 選択中のウォールが消えた場合は既定ウォールへ切り替える。
            currentWallId = '';
            saveWallId('');
          }
          fetchState();
        })
        .catch(function (err) {
          if (err && err.message === 'unauthorized') return;
          showToast('削除に失敗しました');
        });
    });
  }

  // ---- ウォール新規作成フォーム ----

  function renderNewWallTerms() {
    el.wallNewTermList.replaceChildren();
    el.wallNewTermEmpty.hidden = newWallTerms.length > 0;

    newWallTerms.forEach(function (term, idx) {
      var li = document.createElement('li');
      li.className = 'term-chip term-chip-' + term.type;

      var icon = document.createElement('i');
      icon.className = (term.type === 'hashtag' ? 'fa-solid fa-hashtag' : 'fa-solid fa-font');
      icon.setAttribute('aria-hidden', 'true');
      li.appendChild(icon);

      var label = document.createElement('span');
      label.className = 'term-label';
      label.textContent = term.value;
      li.appendChild(label);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'term-remove';
      remove.setAttribute('aria-label', term.value + ' を削除');
      remove.title = '削除';
      var removeIcon = document.createElement('i');
      removeIcon.className = 'fa-solid fa-xmark';
      removeIcon.setAttribute('aria-hidden', 'true');
      remove.appendChild(removeIcon);
      remove.addEventListener('click', function () {
        newWallTerms.splice(idx, 1);
        renderNewWallTerms();
      });
      li.appendChild(remove);

      el.wallNewTermList.appendChild(li);
    });
  }

  function addNewWallTerm() {
    var raw = (el.wallNewTermInput.value || '').trim();
    if (!raw) {
      showToast('監視する語を入力してください');
      return;
    }
    var type = el.wallNewTermKeywordCheck.checked ? 'keyword' : 'hashtag';
    var value = type === 'hashtag' ? raw.replace(/^[#＃]+/, '') : raw;
    if (!value) {
      showToast('監視する語を入力してください');
      return;
    }
    if (type === 'keyword' && value.length < 2) {
      showToast('キーワードは 2 文字以上で指定してください');
      return;
    }
    var duplicated = newWallTerms.some(function (t) {
      return t.type === type && t.value.toLowerCase() === value.toLowerCase();
    });
    if (duplicated) {
      showToast('すでに追加されています');
      return;
    }
    newWallTerms.push({ value: value, type: type });
    renderNewWallTerms();
    el.wallNewTermInput.value = '';
    el.wallNewTermInput.focus();
  }

  el.wallNewTermAddBtn.addEventListener('click', addNewWallTerm);
  bindEnter(el.wallNewTermInput, addNewWallTerm);
  bindEnter(el.wallNewNameInput, function () {
    el.wallCreateBtn.click();
  });
  bindEnter(el.modlistActorInput, function () {
    el.modlistLoadBtn.click();
  });

  el.wallCreateBtn.addEventListener('click', function () {
    var name = (el.wallNewNameInput.value || '').trim();
    if (!name) {
      showToast('ウォール名を入力してください');
      return;
    }
    if (newWallTerms.length === 0) {
      showToast('監視語を 1 つ以上追加してください');
      return;
    }
    if (lastWalls.length >= MAX_WALLS) {
      showToast('ウォールは ' + MAX_WALLS + ' 個までです');
      return;
    }
    el.wallCreateBtn.disabled = true;
    apiFetch('/api/admin/walls', {
      method: 'POST',
      body: JSON.stringify({
        name: name,
        terms: newWallTerms.map(function (t) { return { value: t.value, type: t.type }; }),
      }),
    })
      .then(function (res) {
        if (res.status === 401) {
          handleUnauthorized();
          throw new Error('unauthorized');
        }
        if (!res.ok) {
          return res.json().catch(function () { return null; }).then(function (body) {
            throw new Error((body && body.error) || 'request failed');
          });
        }
        return res.json();
      })
      .then(function (data) {
        showToast('ウォール「' + data.wall.name + '」を作成しました');
        el.wallNewNameInput.value = '';
        newWallTerms = [];
        renderNewWallTerms();
        fetchState();
      })
      .catch(function (err) {
        if (err && err.message === 'unauthorized') return;
        showToast(err && err.message ? err.message : 'ウォールの作成に失敗しました');
      })
      .then(function () {
        updateWallCreateAvailability(lastWalls.length);
      });
  });

  // <dialog> を使った確認。alert/confirm はページ全体を止めるため使わない。
  var confirmHandler = null;
  function openConfirm(message, onOk) {
    confirmHandler = onOk;
    el.confirmMessage.textContent = message;
    if (typeof el.confirmDialog.showModal === 'function') {
      el.confirmDialog.showModal();
    } else {
      // <dialog> 非対応環境では即座に実行せず、操作を中止する。
      showToast('この環境では確認ダイアログを表示できません');
      confirmHandler = null;
    }
  }

  el.confirmDialog.addEventListener('close', function () {
    var handler = confirmHandler;
    confirmHandler = null;
    if (el.confirmDialog.returnValue === 'ok' && handler) handler();
  });

  // 購読中のモデレーションリスト。
  function renderModLists(lists) {
    el.modlistCount.textContent = String(lists.length);
    el.modlistEmpty.hidden = lists.length > 0;
    el.modlistSubscribed.replaceChildren();

    lists.forEach(function (info) {
      var li = document.createElement('li');
      li.className = 'actor-item';

      var body = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'actor-name';
      name.textContent = info.name;
      body.appendChild(name);

      var meta = document.createElement('div');
      meta.className = 'field-note list-meta';
      meta.appendChild(buildListKindBadge(info.purpose));

      var count = document.createElement('span');
      count.textContent = info.error
        ? info.memberCount + ' 件 (最新の取得に失敗: ' + info.error + ')'
        : info.memberCount + ' 件';
      meta.appendChild(count);
      body.appendChild(meta);
      li.appendChild(body);

      var btn = document.createElement('button');
      btn.className = 'btn btn-neutral btn-small';
      btn.innerHTML = '<i class="fa-solid fa-link-slash fa-fw" aria-hidden="true"></i> 購読解除';
      btn.addEventListener('click', function () {
        apiFetch('/api/admin/modlists', {
          method: 'DELETE',
          body: JSON.stringify({ uri: info.uri }),
        })
          .then(function () { fetchState(); })
          .catch(function () { showToast('購読解除に失敗しました'); });
      });
      li.appendChild(btn);

      el.modlistSubscribed.appendChild(li);
    });
  }

  // ログイン中のセッション数と、自分のセッションの残り時間を表示する。
  var sessionInfoAt = 0;
  function refreshSessionInfo() {
    var now = Date.now();
    if (now - sessionInfoAt < 30000) {
      updateSessionExpiryLabel();
      return;
    }
    sessionInfoAt = now;
    apiFetch('/api/admin/sessions')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        el.sessionCount.textContent = String((data.sessions || []).length);
        updateSessionExpiryLabel();
      })
      .catch(function () { /* 表示できなくても運用に支障はない */ });
  }

  function updateSessionExpiryLabel() {
    if (!sessionExpiresAt) {
      el.sessionExpiry.textContent = '';
      return;
    }
    var remainMin = Math.max(0, Math.round((sessionExpiresAt - Date.now()) / 60000));
    var hours = Math.floor(remainMin / 60);
    var mins = remainMin % 60;
    el.sessionExpiry.textContent =
      '(自分の残り ' + (hours > 0 ? hours + '時間' : '') + mins + '分)';
  }

  function renderHiddenList(posts) {
    var list = posts || [];
    el.hiddenCount.textContent = String(list.length);
    el.hiddenList.innerHTML = '';
    el.hiddenEmpty.hidden = list.length > 0;
    list.forEach(function (post) {
      el.hiddenList.appendChild(buildPostItem(post, { approve: false, hide: false, block: false, unhide: true }));
    });
  }

  // ブロック中の投稿者。解除すると、ブロック時に取り下げた投稿も復元される。
  function renderBlockedList(actors) {
    var list = actors || [];
    el.blockedCount.textContent = String(list.length);
    el.blockedList.innerHTML = '';
    el.blockedEmpty.hidden = list.length > 0;
    list.forEach(function (actor) {
      var li = document.createElement('li');
      li.className = 'actor-item';

      var name = document.createElement('span');
      name.className = 'actor-name';
      name.textContent = actor;
      li.appendChild(name);

      var btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-small';
      btn.innerHTML = '<i class="fa-solid fa-unlock fa-fw" aria-hidden="true"></i> ブロック解除';
      btn.addEventListener('click', function () {
        callAdminApi('/api/admin/unblock', { did: actor })
          .then(function () { fetchState(); })
          .catch(function () { showToast('ブロック解除に失敗しました'); });
      });
      li.appendChild(btn);

      el.blockedList.appendChild(li);
    });
  }

  /**
   * 投稿 1 件分の <li> を構築する。
   * XSS 対策: 投稿本文・表示名等はすべて textContent で挿入する。
   */
  function buildPostItem(post, actions) {
    var li = document.createElement('li');
    li.className = 'post-item';

    var head = document.createElement('div');
    head.className = 'post-item-head';

    var author = document.createElement('span');
    author.className = 'post-author';
    var displayName = (post.author && post.author.displayName) || (post.author && post.author.handle) || post.did || '(不明)';
    author.textContent = displayName;
    head.appendChild(author);

    if (post.author && post.author.handle) {
      var handle = document.createElement('span');
      handle.className = 'post-handle';
      handle.textContent = '@' + post.author.handle;
      head.appendChild(handle);
    }

    var time = document.createElement('span');
    time.className = 'post-time';
    time.textContent = formatTime(post.createdAt);
    head.appendChild(time);

    li.appendChild(head);

    var text = document.createElement('div');
    text.className = 'post-text';
    text.textContent = post.text || '';
    li.appendChild(text);

    var meta = document.createElement('div');
    meta.className = 'post-meta';
    var imageCount = (post.images && post.images.length) || 0;
    meta.textContent = imageCount > 0 ? '画像 ' + imageCount + ' 枚' : '画像なし';
    li.appendChild(meta);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'post-actions';

    if (actions.approve) {
      var approveBtn = document.createElement('button');
      approveBtn.className = 'btn btn-primary btn-small';
      approveBtn.innerHTML = '<i class="fa-solid fa-check fa-fw" aria-hidden="true"></i> 承認';
      approveBtn.addEventListener('click', function () {
        callAdminApi('/api/admin/approve', { uri: post.uri, wall: currentWallId || undefined })
          .then(function () { fetchState(); })
          .catch(function () { showToast('承認に失敗しました'); });
      });
      actionsRow.appendChild(approveBtn);
    }

    if (actions.hide) {
      var hideBtn = document.createElement('button');
      hideBtn.className = 'btn btn-neutral btn-small';
      hideBtn.innerHTML = '<i class="fa-solid fa-eye-slash fa-fw" aria-hidden="true"></i> 非表示';
      hideBtn.addEventListener('click', function () {
        callAdminApi('/api/admin/hide', { uri: post.uri })
          .then(function () { fetchState(); })
          .catch(function () { showToast('非表示処理に失敗しました'); });
      });
      actionsRow.appendChild(hideBtn);
    }

    if (actions.unhide) {
      var unhideBtn = document.createElement('button');
      unhideBtn.className = 'btn btn-primary btn-small';
      unhideBtn.innerHTML = '<i class="fa-solid fa-rotate-left fa-fw" aria-hidden="true"></i> 復元';
      unhideBtn.addEventListener('click', function () {
        callAdminApi('/api/admin/unhide', { uri: post.uri })
          .then(function () { fetchState(); })
          .catch(function () { showToast('復元に失敗しました'); });
      });
      actionsRow.appendChild(unhideBtn);
    }

    if (actions.block && post.did) {
      var blockBtn = makeInlineConfirmButton({
        label: '投稿者をブロック',
        icon: 'fa-solid fa-ban',
        confirmLabel: '本当に？',
        className: 'btn btn-danger btn-small',
        onConfirm: function () {
          callAdminApi('/api/admin/block', { did: post.did })
            .then(function () { fetchState(); })
            .catch(function () { showToast('ブロックに失敗しました'); });
        },
      });
      actionsRow.appendChild(blockBtn);
    }

    li.appendChild(actionsRow);

    return li;
  }

  /**
   * インライン二段階確認ボタンを作る。
   * 1 回目のクリックで「本当に？」に変わり、3 秒以内に再クリックで確定。
   * window.confirm 等のブラウザダイアログは使用しない。
   */
  function makeInlineConfirmButton(opts) {
    var btn = document.createElement('button');
    btn.className = opts.className;

    // アイコンとラベルを別要素に分ける。
    // textContent で書き換えるとアイコンごと消えてしまうため。
    var iconEl = document.createElement('i');
    iconEl.className = (opts.icon || 'fa-solid fa-circle-question') + ' fa-fw';
    iconEl.setAttribute('aria-hidden', 'true');
    var labelEl = document.createElement('span');
    labelEl.textContent = opts.label;
    btn.appendChild(iconEl);
    btn.appendChild(document.createTextNode(' '));
    btn.appendChild(labelEl);

    var confirming = false;
    var resetTimer = null;

    function reset() {
      confirming = false;
      iconEl.className = (opts.icon || 'fa-solid fa-circle-question') + ' fa-fw';
      labelEl.textContent = opts.label;
      btn.classList.remove('btn-confirming');
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
    }

    btn.addEventListener('click', function () {
      if (!confirming) {
        confirming = true;
        // 確認待ちであることをアイコンでも示す。
        iconEl.className = 'fa-solid fa-triangle-exclamation fa-fw';
        labelEl.textContent = opts.confirmLabel;
        btn.classList.add('btn-confirming');
        resetTimer = setTimeout(reset, CONFIRM_TIMEOUT_MS);
        return;
      }
      reset();
      opts.onConfirm();
    });

    return btn;
  }

  function callAdminApi(path, bodyObj) {
    var options = { method: 'POST' };
    if (bodyObj !== undefined) {
      options.body = JSON.stringify(bodyObj);
    }
    return apiFetch(path, options).then(function (res) {
      if (res.status === 401) {
        handleUnauthorized();
        throw new Error('unauthorized');
      }
      if (!res.ok) {
        throw new Error('request failed: ' + res.status);
      }
      return res;
    });
  }

  /**
   * テキスト入力の Enter を、IME の変換確定と区別して拾う。
   *
   * 日本語・中国語・韓国語の入力では、変換候補を確定する Enter が
   * そのまま送信として扱われてしまう。変換中かどうかを見て抑止する。
   *
   * 判定は 3 段構え。
   *  - compositionstart / compositionend で自前に変換中を追う
   *  - evt.isComposing (標準)
   *  - evt.keyCode === 229 (isComposing を立てない古い実装への保険)
   * さらに、変換確定の直後に同じ Enter がもう一度 keydown として
   * 届く実装があるため、確定から次のイベントループまでは無視する。
   */
  function bindEnter(input, handler) {
    if (!input) return;
    var composing = false;
    var justComposed = false;

    input.addEventListener('compositionstart', function () {
      composing = true;
    });
    input.addEventListener('compositionend', function () {
      composing = false;
      justComposed = true;
      setTimeout(function () {
        justComposed = false;
      }, 0);
    });

    input.addEventListener('keydown', function (evt) {
      if (evt.key !== 'Enter') return;
      // 変換中でも既定動作は止める。フォーム内の入力欄では、
      // 何もしないと変換確定の Enter がそのまま暗黙送信になってしまう。
      evt.preventDefault();
      if (composing || justComposed || evt.isComposing || evt.keyCode === 229) return;
      handler();
    });
  }

  // ==========================================================
  // イベントハンドラ
  // ==========================================================

  function addTerm() {
    var raw = (el.termInput.value || '').trim();
    if (!raw) {
      showToast('監視する語を入力してください');
      return;
    }
    var type = el.termKeywordCheck.checked ? 'keyword' : 'hashtag';
    var value = type === 'hashtag' ? raw.replace(/^[#＃]+/, '') : raw;
    if (!value) {
      showToast('監視する語を入力してください');
      return;
    }
    if (type === 'keyword' && value.length < 2) {
      showToast('キーワードは 2 文字以上で指定してください');
      return;
    }
    var duplicated = currentTerms.some(function (t) {
      return t.type === type && t.value.toLowerCase() === value.toLowerCase();
    });
    if (duplicated) {
      showToast('すでに登録されています');
      return;
    }

    saveTerms(currentTerms.concat([{ value: value, type: type }]), '監視対象に追加しました');
    el.termInput.value = '';
    el.termInput.focus();
  }

  el.termAddBtn.addEventListener('click', addTerm);
  bindEnter(el.termInput, addTerm);

  el.jetstreamSwitchBtn.addEventListener('click', function () {
    var host = el.jetstreamSelect.value;
    if (!host) return;
    callAdminApi('/api/admin/jetstream', { host: host })
      .then(function () {
        showToast('接続先を切り替えました: ' + host);
        fetchState();
      })
      .catch(function () { showToast('切り替えに失敗しました'); });
  });

  el.modlistLoadBtn.addEventListener('click', function () {
    var actor = (el.modlistActorInput.value || '').trim();
    var path = '/api/admin/modlists/available' + (actor ? '?actor=' + encodeURIComponent(actor) : '');
    el.modlistLoadBtn.disabled = true;
    apiFetch(path)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        el.modlistLoadBtn.disabled = false;
        if (!data) {
          showToast('リストを取得できませんでした');
          return;
        }
        renderAvailableLists(data.lists || []);
      })
      .catch(function () {
        el.modlistLoadBtn.disabled = false;
        showToast('リストを取得できませんでした');
      });
  });

  /**
   * リストの種別バッジを作る。
   * modlist (モデレーションリスト) と curatelist (通常のリスト) を
   * アイコンと色で区別する。用途が違うものを取り違えないようにするため。
   */
  function buildListKindBadge(purpose) {
    var isMod = String(purpose || '').indexOf('modlist') >= 0;
    var badge = document.createElement('span');
    badge.className = 'list-badge ' + (isMod ? 'list-badge-mod' : 'list-badge-curate');

    var icon = document.createElement('i');
    icon.className = isMod ? 'fa-solid fa-shield-halved' : 'fa-solid fa-bookmark';
    icon.setAttribute('aria-hidden', 'true');
    badge.appendChild(icon);

    var label = document.createElement('span');
    label.textContent = isMod ? 'モデレーション' : '通常リスト';
    badge.appendChild(label);

    badge.title = isMod
      ? 'モデレーションリスト: 掲載アカウントを非表示にする用途のリスト'
      : '通常リスト (キュレーションリスト): 本来は購読して見るためのリスト';
    return badge;
  }

  // 取得したリストの候補を並べ、購読ボタンを付ける。
  function renderAvailableLists(lists) {
    el.modlistAvailable.replaceChildren();
    if (lists.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty-msg';
      empty.textContent = 'このアカウントにはリストがありません。';
      el.modlistAvailable.appendChild(empty);
      return;
    }
    lists.forEach(function (list) {
      var li = document.createElement('li');
      li.className = 'actor-item';

      var body = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'actor-name';
      name.textContent = list.name;
      body.appendChild(name);

      var meta = document.createElement('div');
      meta.className = 'field-note list-meta';
      // modlist 以外 (curatelist など) も購読はできるが、用途が違うことを示す。
      meta.appendChild(buildListKindBadge(list.purpose));

      var count = document.createElement('span');
      count.textContent = list.itemCount + ' 件';
      meta.appendChild(count);
      body.appendChild(meta);
      li.appendChild(body);

      var btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-small';
      btn.innerHTML = '<i class="fa-solid fa-link fa-fw" aria-hidden="true"></i> 購読';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        callAdminApi('/api/admin/modlists', { uri: list.uri })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            showToast('購読しました (' + data.info.memberCount + ' 件 / 取り下げ ' + data.removed + ' 件)');
            fetchState();
          })
          .catch(function () {
            btn.disabled = false;
            showToast('購読に失敗しました');
          });
      });
      li.appendChild(btn);

      el.modlistAvailable.appendChild(li);
    });
  }

  el.oauthBtn.addEventListener('click', function () {
    var handle = (el.handleInput.value || '').trim();
    if (!handle) {
      showLogin('ハンドルを入力してください');
      return;
    }
    el.oauthBtn.disabled = true;
    apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ handle: handle }) })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.url) {
          el.oauthBtn.disabled = false;
          showLogin('アカウントを解決できませんでした。ハンドルを確認してください。');
          return;
        }
        // 認可のため利用者の PDS へ遷移する。
        location.href = data.url;
      })
      .catch(function () {
        el.oauthBtn.disabled = false;
        showLogin('サーバーに接続できません');
      });
  });

  bindEnter(el.handleInput, function () {
    el.oauthBtn.click();
  });

  el.connectBtn.addEventListener('click', function () {
    var token = el.tokenInput.value || '';
    el.connectBtn.disabled = true;

    // トークンを送るのはこの 1 回だけ。以降はセッション Cookie で認証する。
    apiFetch('/api/admin/session', {
      method: 'POST',
      body: JSON.stringify({ token: token }),
    })
      .then(function (res) {
        if (res.status === 429) {
          showLogin('試行回数が多すぎます。しばらく待ってからやり直してください。');
          return null;
        }
        if (!res.ok) {
          showLogin('トークンが正しくありません');
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        el.tokenInput.value = '';
        sessionExpiresAt = data.expiresAt || 0;
        connect();
      })
      .catch(function () {
        showLogin('サーバーに接続できません');
      })
      .then(function () {
        el.connectBtn.disabled = false;
      });
  });

  bindEnter(el.tokenInput, function () {
    el.connectBtn.click();
  });

  el.clearTokenBtn.addEventListener('click', function () {
    removeToken();
    el.tokenInput.value = '';
  });

  // トークンが漏れた疑いがあるときの緊急手段。自分自身もログアウトされる。
  el.revokeSessionsBtn.replaceWith(
    makeInlineConfirmButton({
      label: '全セッション失効',
      icon: 'fa-solid fa-user-lock',
      confirmLabel: '本当に？',
      className: 'btn btn-danger',
      onConfirm: function () {
        callAdminApi('/api/admin/sessions/revoke-all')
          .then(function () {
            stopPolling();
            sessionExpiresAt = 0;
            showLogin('全セッションを失効しました。再度ログインしてください。');
          })
          .catch(function () { showToast('失効に失敗しました'); });
      },
    })
  );

  el.logoutBtn.addEventListener('click', function () {
    stopPolling();
    // サーバー側のセッションも確実に失効させる。
    apiFetch('/api/admin/session', { method: 'DELETE' })
      .catch(function () { /* 失効できなくても画面は戻す */ })
      .then(function () {
        removeToken();
        sessionExpiresAt = 0;
        showLogin();
      });
  });

  el.openWallBtn.addEventListener('click', function () {
    var path = currentWallId ? '/wall/' + encodeURIComponent(currentWallId) : '/wall';
    window.open(path, '_blank', 'noopener');
  });

  el.themeToggleBtn.addEventListener('click', toggleTheme);

  el.pauseToggle.addEventListener('click', function () {
    if (pauseRequestInFlight) return;
    var nextPaused = !isPaused;
    pauseRequestInFlight = true;
    callAdminApi('/api/admin/pause', { paused: nextPaused })
      .then(function () {
        isPaused = nextPaused;
        updatePauseUI();
      })
      .catch(function () {
        showToast('一時停止の切り替えに失敗しました');
      })
      .then(function () {
        pauseRequestInFlight = false;
        fetchState();
      });
  });

  var clearAllInlineBtn = makeInlineConfirmButton({
    label: '全消去',
    icon: 'fa-solid fa-broom',
    confirmLabel: '本当に？',
    className: 'btn btn-danger',
    onConfirm: function () {
      callAdminApi('/api/admin/clear', { wall: currentWallId || undefined })
        .then(function () { fetchState(); })
        .catch(function () { showToast('全消去に失敗しました'); });
    },
  });
  el.clearAllBtn.parentNode.replaceChild(clearAllInlineBtn, el.clearAllBtn);
  el.clearAllBtn = clearAllInlineBtn;

  // ==========================================================
  // 起動
  // ==========================================================

  function connect() {
    showApp();
    startPolling();
  }

  // サーバーが受け付ける認証方式を問い合わせ、ログイン画面を出し分ける。
  function applyAuthConfig() {
    return fetch('/api/auth/config', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : { token: true, oauth: false }; })
      .catch(function () { return { token: true, oauth: false }; })
      .then(function (cfg) {
        authConfig = cfg;
        el.oauthLogin.hidden = !cfg.oauth;
        el.tokenLogin.hidden = !cfg.token;
        el.loginDivider.hidden = !(cfg.oauth && cfg.token);
      });
  }

  // OAuth のコールバックはリダイレクトで戻るため、クエリでエラーを受け取る。
  function readAuthError() {
    var params = new URLSearchParams(location.search);
    var err = params.get('error');
    if (!err) return '';
    // 履歴に残さないよう、読み取ったら URL から取り除く。
    history.replaceState(null, '', location.pathname);
    if (err === 'not_allowed') {
      return 'このアカウントは管理を許可されていません。主催者に ADMIN_ACTORS への追加を依頼してください。';
    }
    return 'ログインに失敗しました。もう一度お試しください。';
  }

  function init() {
    removeToken(); // 旧バージョンが localStorage に残したトークンを掃除する

    var authError = readAuthError();

    applyAuthConfig().then(function () {
      if (authError) {
        showLogin(authError);
        return;
      }
      // OAuth のコールバックから戻ってきた直後は、既にセッション Cookie がある。
      // 有効なら入力画面を出さずにそのまま管理画面へ入る。
      apiFetch('/api/admin/state')
        .then(function (res) {
          if (!res.ok) {
            showLogin();
            return;
          }
          connect();
        })
        .catch(function () {
          showLogin();
        });
    });
  }

  init();
})();
