/**
 * Bluesky Live Wall - 管理画面ロジック
 * ビルドツール不使用。素の JavaScript のみ。外部 CDN には依存しない
 * (Web Awesome もローカルに vendoring 済みのものを読み込む)。
 *
 * API 契約 (docs/task-breakdown.md):
 *   GET  /api/admin/state   -> { state: WallState, recent: WallPost[], pending: WallPost[] }
 *   POST /api/admin/pause   body { paused: boolean }
 *   POST /api/admin/hide    body { uri: string }
 *   POST /api/admin/approve body { uri: string }
 *   POST /api/admin/block   body { did: string }
 *   POST /api/admin/clear   (body なし)
 * すべて Authorization: Bearer <ADMIN_TOKEN> を付与する。
 *
 * type="module" として読み込まれる (index.html 側)。Web Awesome の各
 * コンポーネント定義も module script のため、これにより実行順序が
 * 「コンポーネント定義 → この admin.js」の順に揃う (defer 相当)。
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
    backfillMinutes: document.getElementById('backfill-minutes'),
    backfillTarget: document.getElementById('backfill-target'),
    backfillRunBtn: document.getElementById('backfill-run-btn'),
    backfillStatus: document.getElementById('backfill-status'),
    backfillStatusText: document.getElementById('backfill-status-text'),
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
    modMode: document.getElementById('mod-mode'),
    uptime: document.getElementById('uptime'),

    statMatched: document.getElementById('stat-matched'),
    statDisplayed: document.getElementById('stat-displayed'),
    statRejected: document.getElementById('stat-rejected'),
    statAuthors: document.getElementById('stat-authors'),

    pauseToggle: document.getElementById('pause-toggle'),
    pauseToggleLabel: document.getElementById('pause-toggle-label'),

    pendingPanel: document.getElementById('pending-panel'),
    pendingList: document.getElementById('pending-list'),
    pendingEmpty: document.getElementById('pending-empty'),
    pendingCount: document.getElementById('pending-count'),

    recentList: document.getElementById('recent-list'),
    recentEmpty: document.getElementById('recent-empty'),
    recentCount: document.getElementById('recent-count'),

    // ウォール単位の表示ラベル
    statusWallName: document.getElementById('status-wall-name'),
    clearWallName: document.getElementById('clear-wall-name'),
    watchWallName: document.getElementById('watch-wall-name'),
    pendingWallName: document.getElementById('pending-wall-name'),
    recentWallName: document.getElementById('recent-wall-name'),

    // ウォールのタブ (タブ自体がウォール一覧を兼ねる)
    wallTabGroup: document.getElementById('wall-tab-group'),
    wallTabNew: document.getElementById('wall-tab-new'),
    wallPanelNew: document.getElementById('wall-panel-new'),

    // 選択中のウォールのタブパネルへ移し替えて使い回す共有ブロック
    wallContent: document.getElementById('wall-content'),
    clearAllSlot: document.getElementById('clear-all-slot'),
    wallRenameSlot: document.getElementById('wall-rename-slot'),
    wallDeleteRow: document.getElementById('wall-delete-row'),
    wallDeleteBtn: document.getElementById('wall-delete-btn'),
    wallOpenLink: document.getElementById('wall-open-link'),
    wallIdDisplay: document.getElementById('wall-id-display'),

    // ウォール新規作成タブ
    wallNewNameInput: document.getElementById('wall-new-name-input'),
    wallNewTermInput: document.getElementById('wall-new-term-input'),
    wallNewTermAddBtn: document.getElementById('wall-new-term-add-btn'),
    wallNewTermKeywordCheck: document.getElementById('wall-new-term-keyword-check'),
    wallNewTermList: document.getElementById('wall-new-term-list'),
    wallNewTermEmpty: document.getElementById('wall-new-term-empty'),
    wallCreateBtn: document.getElementById('wall-create-btn'),
    wallLimitNote: document.getElementById('wall-limit-note'),
  };

  // 参照できなかった要素を早期に洗い出す。
  // 1 つでも undefined のままだと、そこで addEventListener が例外を投げて
  // 以降の初期化がすべて止まり、画面が固まったように見えるため。
  (function checkElements() {
    var missing = Object.keys(el).filter(function (k) {
      return !el[k];
    });
    if (missing.length > 0) {
      console.error('[admin] 見つからない要素があります:', missing.join(', '));
    }
  })();

  // ---------- 状態 ----------
  var pollTimer = null;
  /** サーバーの起動時刻。稼働時間を毎秒描き直すために保持する。 */
  var serverStartedAt = 0;
  var sessionExpiresAt = 0;
  // サーバーが受け付ける認証方式。エラーメッセージの出し分けに使う。
  var authConfig = { token: true, oauth: false };
  var isPaused = false;
  var pauseRequestInFlight = false;

  // 選択中のウォール。空文字は「既定ウォール」を意味する。
  // 解決後 (state.wallId を受け取った後) は具体的な ID に置き換える。
  var currentWallId = loadWallId();
  // 直近に取得したウォール一覧 (タブの再構築や上限判定に使う)。
  var lastWalls = [];
  // 改名フォームを開いているウォール ID (null なら非表示)。
  var renamingWallId = null;
  // 「+ ウォールを追加」タブを開いている間は、3 秒ごとのポーリングによる
  // 再描画で選択中のウォールのタブへ強制的に戻さないようにする。
  // これを入れないと、タブを開いた直後にポーリングが走ってタブごと
  // 元に戻ってしまい、フォームへ到達できなくなる。
  var stayOnNewWallTab = false;
  // ウォール新規作成タブで積んでいる監視語。
  var newWallTerms = [];

  // タブ / タブパネルの DOM を使い回すための対応表 (ウォール ID -> 要素)。
  // ポーリングのたびに作り直すと、選択状態やフォーカスが毎回失われるため。
  var wallTabEls = {};
  var wallPanelEls = {};

  function wallPanelName(id) {
    return 'wall-' + id;
  }

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

  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // 実際に適用される明暗を解決する ('' は端末設定に従う「自動」を意味する)。
  function effectiveTheme(theme) {
    if (theme === 'dark' || theme === 'light') return theme;
    return prefersDark() ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    // Web Awesome は独自に .wa-dark / .wa-light クラスでテーマを切り替える。
    // 既存の data-theme 属性 (自前の CSS 変数) と食い違わないよう、常に両方揃える。
    var eff = effectiveTheme(theme);
    document.documentElement.classList.toggle('wa-dark', eff === 'dark');
    document.documentElement.classList.toggle('wa-light', eff === 'light');
    updateThemeIcon();
  }

  // 現在のテーマを示すアイコンに差し替える (暗いとき月、明るいとき太陽)。
  function updateThemeIcon() {
    var iconEl = document.getElementById('theme-icon');
    if (!iconEl) return;
    var isDark = effectiveTheme(document.documentElement.getAttribute('data-theme')) === 'dark';
    iconEl.className = (isDark ? 'fa-solid fa-moon' : 'fa-solid fa-sun') + ' fa-fw';
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    var effectiveCurrent = current || (prefersDark() ? 'dark' : 'light');
    var next = effectiveCurrent === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_THEME_KEY, next);
    } catch (e) {
      // 無視
    }
  }

  applyTheme(loadTheme());

  // 「自動」(data-theme 未設定) のときは、端末側のライト/ダーク切替にも追随する。
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (!document.documentElement.getAttribute('data-theme')) {
        applyTheme('');
      }
    });
  }

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

  function wallNameOf(id) {
    for (var i = 0; i < lastWalls.length; i++) {
      if (lastWalls[i].id === id) return lastWalls[i].name;
    }
    return id;
  }

  function renderState(data) {
    var state = data.state || {};
    var jetstream = state.jetstream || {};
    var stats = state.stats || {};

    // Jetstream 接続状態 (wa-badge の variant で色分けする)。
    if (jetstream.connected) {
      el.jsConnected.textContent = '接続中';
      el.jsConnected.setAttribute('variant', 'success');
    } else {
      el.jsConnected.textContent = '切断';
      el.jsConnected.setAttribute('variant', 'danger');
    }
    el.jsHost.textContent = jetstream.host || '-';
    el.jsReconnects.textContent = (jetstream.reconnects != null) ? String(jetstream.reconnects) : '-';

    el.modMode.textContent = state.moderationMode === 'approve' ? '承認モード' : '公開モード';
    // 稼働時間はポーリング間隔 (3 秒) ではなく毎秒進めたいので、
    // 起点だけ保持してローカルのタイマーで描き直す。
    serverStartedAt = stats.startedAt || 0;
    el.uptime.textContent = formatUptime(serverStartedAt);

    // 統計 (選択中のウォールのもの)
    el.statMatched.textContent = stats.matched != null ? stats.matched : 0;
    el.statDisplayed.textContent = stats.displayed != null ? stats.displayed : 0;
    el.statRejected.textContent = stats.rejected != null ? stats.rejected : 0;
    el.statAuthors.textContent = stats.authors != null ? stats.authors : 0;

    // 一時停止状態
    isPaused = !!state.paused;
    updatePauseUI();

    renderWatchSettings(data);
    renderModLists(data.modLists || []);
    renderHiddenList(data.hidden || []);
    renderBlockedList(data.blocked || []);
    renderBackfillStatus(data.backfill);
    refreshSessionInfo();

    // ウォール単位の表示ラベル
    var wallName = state.wallName || '-';
    el.statusWallName.textContent = wallName;
    el.clearWallName.textContent = wallName;
    el.watchWallName.textContent = wallName;
    el.pendingWallName.textContent = wallName;
    el.recentWallName.textContent = wallName;

    lastWalls = data.walls || [];
    renderWallTabs(lastWalls, state.wallId);
    updateWallCreateAvailability(lastWalls.length);

    // 承認待ちパネルの表示切替。
    // approve モードでなくても、キーワードのみ一致した投稿は承認待ちに入る。
    // 件数があるのにパネルが隠れていると、確認も承認もできなくなる。
    var pendingItems = data.pending || [];
    el.pendingPanel.hidden = state.moderationMode !== 'approve' && pendingItems.length === 0;

    renderTerms(state.terms || []);
    renderPendingList(pendingItems);
    renderRecentList(data.recent || []);

    var activeWall = null;
    for (var i = 0; i < lastWalls.length; i++) {
      if (lastWalls[i].id === state.wallId) {
        activeWall = lastWalls[i];
        break;
      }
    }
    renderWallActions(activeWall);
  }

  function updatePauseUI() {
    // 稼働中 (配信有効) を checked=true、停止中を checked=false とする。
    // 停止中は一目で分かるよう、赤系の配色にする (CSS 側で対応)。
    el.pauseToggle.checked = !isPaused;
    // checked が属性として反映されない環境でも色が変わるよう、クラスでも状態を持つ。
    el.pauseToggle.classList.toggle('is-on', !isPaused);
    el.pauseToggleLabel.textContent = isPaused ? '停止中' : '有効';
    el.pauseBanner.hidden = !isPaused;
  }

  // 稼働時間は 1 秒ごとに進める。サーバーへの問い合わせは不要で、
  // 起点からの差分を計算し直すだけ。ポーリング間隔 (3 秒) に引きずられない。
  setInterval(function () {
    if (serverStartedAt) el.uptime.textContent = formatUptime(serverStartedAt);
  }, 1000);

  function renderPendingList(posts) {
    el.pendingCount.textContent = String(posts.length);
    el.pendingList.innerHTML = '';
    el.pendingEmpty.hidden = posts.length > 0;
    posts.forEach(function (post) {
      el.pendingList.appendChild(
        buildPostItem(post, { approve: true, hide: true, block: true, rejectLabel: true })
      );
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

  // 受信設定 (Jetstream 接続先の選択肢)。全ウォール共通。
  function renderWatchSettings(data) {
    var state = data.state || {};
    var hosts = data.jetstreamHosts || [];
    var current = (state.jetstream && state.jetstream.host) || '';
    // 候補が変わっていなければ再構築しない (選択状態を壊さないため)。
    if (el.jetstreamSelect.children.length !== hosts.length) {
      el.jetstreamSelect.replaceChildren();
      hosts.forEach(function (host) {
        var opt = document.createElement('wa-option');
        opt.setAttribute('value', host);
        opt.textContent = host;
        el.jetstreamSelect.appendChild(opt);
      });
    }
    if (current && document.activeElement !== el.jetstreamSelect) {
      el.jetstreamSelect.value = current;
    }
  }

  // 監視対象をチップ (wa-tag) として並べる。「×」で個別に外せる。
  var currentTerms = [];
  function buildTermTag(term, onRemove) {
    var li = document.createElement('li');
    var tag = document.createElement('wa-tag');
    tag.setAttribute('with-remove', '');
    tag.setAttribute('variant', term.type === 'hashtag' ? 'brand' : 'warning');
    tag.setAttribute(
      'aria-label',
      (term.type === 'hashtag' ? 'ハッシュタグ ' : 'キーワード ') + term.value + ' を削除'
    );
    var icon = document.createElement('i');
    icon.className = term.type === 'hashtag' ? 'fa-solid fa-hashtag' : 'fa-solid fa-font';
    icon.setAttribute('aria-hidden', 'true');
    tag.appendChild(icon);
    tag.appendChild(document.createTextNode(' ' + term.value));
    tag.addEventListener('wa-remove', onRemove);
    li.appendChild(tag);
    return li;
  }

  function renderTerms(terms) {
    currentTerms = terms;
    el.termList.replaceChildren();
    el.termEmpty.hidden = terms.length > 0;

    var keywordCount = 0;
    terms.forEach(function (term) {
      if (term.type === 'keyword') keywordCount += 1;
      el.termList.appendChild(
        buildTermTag(term, function () {
          requestRemoveTerm(term);
        })
      );
    });

    // キーワードが設定されているときは、扱いの違いを常に見えるようにする。
    el.keywordWarning.hidden = keywordCount === 0;
    if (keywordCount > 0) {
      el.keywordWarningText.textContent =
        'キーワード ' + keywordCount + ' 件が有効です。' +
        'ハッシュタグの付かない投稿は、イベントを知らない第三者のものである可能性があります。' +
        '既定ではキーワードのみ一致した投稿は下の「承認待ち」に入り、' +
        '承認するまで会場モニターには出ません。';
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
  // ウォールのタブ (タブがウォール一覧を兼ねる)
  // ==========================================================

  /**
   * ウォールごとの <wa-tab> / <wa-tab-panel> を差分更新する。
   * 毎回作り直すと、タブの選択アニメーションやフォーカスが
   * ポーリングのたびに壊れるため、存在するものは中身だけ更新する。
   */
  /**
   * wa-tab-group の選択タブを、指定したウォールへ確実に切り替える。
   *
   * wa-tab-group.setActiveTab(tab) の内部実装は、対象タブが挿入された
   * 直後 (this.tabs キャッシュがまだ更新されていない状態) に呼ばれると、
   * 各タブの aria-selected 等を更新する処理を素通りしたまま
   * 「this.activeTab はそのタブになった」という内部状態だけを
   * 更新してしまう。setActiveTab は `tab !== this.activeTab` を
   * ガード条件にしているため、一度この状態になると、キャッシュが
   * 追いついた後にもう一度呼んでも「もう activeTab のはずだから」と
   * 何もせず抜けてしまい、見た目のタブ切り替えが永久に反映されない。
   *
   * 対策として、直前の結果 (targetTab.active) を見て反映されて
   * いなければ、いったん activeTab を空にしてガードを回避してから
   * 再試行する。
   */
  function applyActiveTab(activeId, activeName) {
    var attempt = function () {
      if (typeof el.wallTabGroup.syncTabsAndPanels === 'function') {
        el.wallTabGroup.syncTabsAndPanels();
      }
      var targetTab = wallTabEls[activeId];
      if (targetTab && typeof el.wallTabGroup.setActiveTab === 'function') {
        if (el.wallTabGroup.activeTab === targetTab && !targetTab.active) {
          // 前回の呼び出しが「反映されないまま activeTab だけ更新された」
          // 状態。ガードを回避するためにいったん解除する。
          el.wallTabGroup.activeTab = null;
        }
        el.wallTabGroup.setActiveTab(targetTab, { emitEvents: false });
        return targetTab.active === true;
      }
      el.wallTabGroup.active = activeName;
      return true;
    };
    // 1 回目で反映されなくても、キャッシュ自体は syncTabsAndPanels() で
    // 同期済みなので、activeTab の固着さえ解除すればその場で (同期的に)
    // 再試行できることが多い。まずは同期的にもう一度試し、それでも
    // ダメな場合だけ描画フレームを待つ (タブがまだ本当に未接続などの
    // 稀なケース向けの保険)。
    if (!attempt() && !attempt()) {
      requestAnimationFrame(function () {
        if (!attempt()) {
          requestAnimationFrame(attempt);
        }
      });
    }
  }

  function renderWallTabs(walls, activeId) {
    var seen = {};

    walls.forEach(function (w) {
      seen[w.id] = true;
      var tab = wallTabEls[w.id];
      var panel = wallPanelEls[w.id];

      if (!tab) {
        tab = document.createElement('wa-tab');
        tab.setAttribute('panel', wallPanelName(w.id));
        wallTabEls[w.id] = tab;
        el.wallTabGroup.insertBefore(tab, el.wallTabNew);
      }
      if (!panel) {
        panel = document.createElement('wa-tab-panel');
        panel.setAttribute('name', wallPanelName(w.id));
        wallPanelEls[w.id] = panel;
        el.wallTabGroup.insertBefore(panel, el.wallPanelNew);
      }

      renderWallTabLabel(tab, w);
    });

    // 一覧から消えたウォール (削除された) のタブ/パネルを取り除く。
    Object.keys(wallTabEls).forEach(function (id) {
      if (!seen[id]) {
        wallTabEls[id].remove();
        if (wallPanelEls[id]) wallPanelEls[id].remove();
        delete wallTabEls[id];
        delete wallPanelEls[id];
      }
    });

    var activeName = activeId ? wallPanelName(activeId) : '';
    if (activeName && !stayOnNewWallTab && el.wallTabGroup.active !== activeName) {
      applyActiveTab(activeId, activeName);
    }

    // 選択中のウォールに対応するパネルへ、使い回しの共有ブロックを移動する。
    var targetPanel = activeId ? wallPanelEls[activeId] : null;
    if (targetPanel && el.wallContent.parentNode !== targetPanel) {
      el.wallContent.hidden = false;
      targetPanel.appendChild(el.wallContent);
    }
  }

  // タブのラベル。ウォール名 + 表示件数 + 承認待ち件数を表示し、
  // 承認待ちがあるタブは警告色のバッジで目立たせる。
  function renderWallTabLabel(tab, w) {
    tab.replaceChildren();
    var label = document.createElement('span');
    label.textContent = w.name;
    tab.appendChild(label);

    var badge = document.createElement('wa-badge');
    badge.setAttribute('variant', w.pendingCount > 0 ? 'warning' : 'neutral');
    var countText = w.postCount + ' 件';
    if (w.pendingCount > 0) countText += ' / 承認待ち ' + w.pendingCount;
    badge.textContent = countText;
    tab.appendChild(badge);
  }

  // ユーザーがタブをクリックして切り替えたときに発火する。
  el.wallTabGroup.addEventListener('wa-tab-show', function (evt) {
    var name = evt.detail && evt.detail.name;
    if (!name) return;
    if (name === 'wall-new') {
      stayOnNewWallTab = true;
      return;
    }
    stayOnNewWallTab = false;
    var id = name.slice('wall-'.length);
    switchWall(id);
  });

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

  // ---- このウォールの操作 (共有ブロック内) ----

  function renderWallActions(wall) {
    if (!wall) return;
    el.wallOpenLink.href = '/wall/' + encodeURIComponent(wall.id);
    el.wallIdDisplay.textContent = wall.id;
    el.wallDeleteRow.hidden = !!wall.isDefault;
    // 改名フォームを開いている間は再描画で入力内容が消えてしまうため、
    // このウォールの分だけ再構築をスキップする。
    if (renamingWallId !== wall.id) {
      renderWallNameDisplay(wall);
    }
  }

  function renderWallNameDisplay(wall) {
    el.wallRenameSlot.replaceChildren();

    var nameSpan = document.createElement('span');
    nameSpan.textContent = wall.name;
    el.wallRenameSlot.appendChild(nameSpan);

    if (wall.isDefault) {
      var badge = document.createElement('span');
      badge.className = 'wall-default-badge';
      badge.textContent = '既定';
      el.wallRenameSlot.appendChild(badge);
    }

    var renameBtn = document.createElement('wa-button');
    renameBtn.setAttribute('size', 's');
    renameBtn.setAttribute('appearance', 'outlined');
    renameBtn.setAttribute('variant', 'neutral');
    var icon = document.createElement('i');
    icon.className = 'fa-solid fa-pen fa-fw';
    icon.setAttribute('aria-hidden', 'true');
    renameBtn.appendChild(icon);
    renameBtn.appendChild(document.createTextNode(' 改名'));
    renameBtn.addEventListener('click', function () {
      renamingWallId = wall.id;
      renderWallRenameForm(wall);
    });
    el.wallRenameSlot.appendChild(renameBtn);
  }

  // 改名用のインラインフォーム。alert/confirm/prompt は使わない。
  function renderWallRenameForm(wall) {
    el.wallRenameSlot.replaceChildren();

    var form = document.createElement('form');
    form.className = 'wall-rename-form';

    var input = document.createElement('wa-input');
    input.value = wall.name;
    input.setAttribute('size', 's');
    input.setAttribute('aria-label', 'ウォール名');
    form.appendChild(input);

    var saveBtn = document.createElement('wa-button');
    saveBtn.type = 'submit';
    saveBtn.setAttribute('size', 's');
    saveBtn.setAttribute('variant', 'brand');
    var saveIcon = document.createElement('i');
    saveIcon.className = 'fa-solid fa-check fa-fw';
    saveIcon.setAttribute('aria-hidden', 'true');
    saveBtn.appendChild(saveIcon);
    form.appendChild(saveBtn);

    var cancelBtn = document.createElement('wa-button');
    cancelBtn.type = 'button';
    cancelBtn.setAttribute('size', 's');
    cancelBtn.setAttribute('appearance', 'plain');
    cancelBtn.setAttribute('variant', 'neutral');
    var cancelIcon = document.createElement('i');
    cancelIcon.className = 'fa-solid fa-xmark fa-fw';
    cancelIcon.setAttribute('aria-hidden', 'true');
    cancelBtn.appendChild(cancelIcon);
    cancelBtn.addEventListener('click', function () {
      renamingWallId = null;
      renderWallNameDisplay(wall);
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

    el.wallRenameSlot.appendChild(form);

    setTimeout(function () {
      input.focus();
      input.select();
    }, 0);
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

  // 削除は wa-dialog による確認を挟む。誤操作でウォールごと消えるのを防ぐため。
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

  el.wallDeleteBtn.addEventListener('click', function () {
    var wall = null;
    for (var i = 0; i < lastWalls.length; i++) {
      if (lastWalls[i].id === currentWallId) { wall = lastWalls[i]; break; }
    }
    if (wall) requestDeleteWall(wall);
  });

  // ---- ウォール新規作成タブ ----

  function renderNewWallTerms() {
    el.wallNewTermList.replaceChildren();
    el.wallNewTermEmpty.hidden = newWallTerms.length > 0;

    newWallTerms.forEach(function (term, idx) {
      el.wallNewTermList.appendChild(
        buildTermTag(term, function () {
          newWallTerms.splice(idx, 1);
          renderNewWallTerms();
        })
      );
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
        // 新しく作ったウォールをそのまま開く。
        // 「+ ウォールを追加」タブに留まる抑制を解除しないと、
        // 作成後もそのタブに固定されたままになってしまう。
        stayOnNewWallTab = false;
        currentWallId = data.wall.id;
        saveWallId(currentWallId);
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

  // ==========================================================
  // 確認ダイアログ (wa-dialog を使う。alert/confirm/prompt は使わない)
  // ==========================================================

  var confirmHandler = null;

  function openConfirm(message, onOk) {
    confirmHandler = onOk;
    el.confirmMessage.textContent = message;
    el.confirmDialog.open = true;
  }

  el.confirmOk.addEventListener('click', function () {
    var handler = confirmHandler;
    confirmHandler = null;
    el.confirmDialog.open = false;
    if (handler) handler();
  });

  // キャンセル側のボタンは data-dialog="close" (HTML 側) で宣言的に閉じる。
  // ここでは、それ以外の経路 (Escape キー等) で閉じた場合の後始末だけ行う。
  el.confirmDialog.addEventListener('wa-after-hide', function () {
    confirmHandler = null;
  });

  /**
   * 過去の取り込みの実行状況。
   * 実行中はボタンを塞ぎ、完了したら結果を残して何が起きたか分かるようにする。
   */
  var lastBackfillFinishedAt = 0;
  function renderBackfillStatus(status) {
    if (!status) {
      el.backfillStatus.hidden = true;
      return;
    }
    el.backfillRunBtn.disabled = status.running;

    if (status.running) {
      var elapsed = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
      var target = status.targetWallId ? 'ウォール「' + wallNameOf(status.targetWallId) + '」' : '全ウォール';
      el.backfillStatusText.textContent =
        '取り込み中: 過去 ' + status.minutes + ' 分 / ' + target + ' (' + elapsed + ' 秒経過)';
      el.backfillStatus.hidden = false;
      return;
    }

    if (!status.finishedAt) {
      el.backfillStatus.hidden = true;
      return;
    }

    var took = status.startedAt ? ((status.finishedAt - status.startedAt) / 1000).toFixed(1) : '-';
    el.backfillStatusText.textContent =
      '直近の取り込み: 過去 ' + status.minutes + ' 分 / ' + status.added + ' 件を追加 (' + took + ' 秒)' +
      (status.caughtUp ? '' : ' — 途中で打ち切られました');
    el.backfillStatus.hidden = false;

    // 完了した瞬間だけ通知する。ポーリングのたびに出すと煩わしいため。
    if (status.finishedAt !== lastBackfillFinishedAt) {
      if (lastBackfillFinishedAt !== 0) {
        showToast(status.added + ' 件を取り込みました');
      }
      lastBackfillFinishedAt = status.finishedAt;
    }
  }

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
   * ポーリングのたびに大量に再構築される可能性があるため、ここだけは
   * 意図的に素の <button> を使う (カスタム要素より生成コストが低い)。
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
      // 承認待ちの投稿はまだ表示されていないため「非表示」では意味が通らない。
      hideBtn.innerHTML = actions.rejectLabel
        ? '<i class="fa-solid fa-circle-xmark fa-fw" aria-hidden="true"></i> 却下'
        : '<i class="fa-solid fa-eye-slash fa-fw" aria-hidden="true"></i> 非表示';
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
   *
   * wa-input / wa-checkbox は内部の Shadow DOM に本物の <input> を持つが、
   * keydown / composition* はいずれも標準の UI イベントで composed: true
   * (シャドウ境界を越えて外側までバブルする) のため、ホスト要素
   * (<wa-input> 自体) に addEventListener するだけで届く。実機の日本語
   * IME で変換確定 Enter が誤送信されないことを確認済み。
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

  // ログインはフォームの送信として扱う。
  // ページ遷移させず、既存の接続処理へ渡す。
  el.tokenLogin.addEventListener('submit', function (evt) {
    evt.preventDefault();
    submitTokenLogin();
  });

  el.connectBtn.addEventListener('click', function (evt) {
    // type=submit なので submit ハンドラ側で処理する。
    evt.preventDefault();
    submitTokenLogin();
  });

  function submitTokenLogin() {
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
  }

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

  el.pauseToggle.addEventListener('change', function () {
    if (pauseRequestInFlight) {
      // 二重送信を避けるため、進行中は表示だけ元に戻す。
      el.pauseToggle.checked = !isPaused;
      return;
    }
    var nextPaused = !el.pauseToggle.checked;
    pauseRequestInFlight = true;
    callAdminApi('/api/admin/pause', { paused: nextPaused })
      .then(function () {
        isPaused = nextPaused;
        updatePauseUI();
      })
      .catch(function () {
        showToast('一時停止の切り替えに失敗しました');
        updatePauseUI(); // 失敗時は表示を元に戻す
      })
      .then(function () {
        pauseRequestInFlight = false;
        fetchState();
      });
  });

  // 表示中の全消去。ウォール単位の操作なので、共有ブロック内のスロットへ
  // ボタンを一度だけ差し込む (クリック時は常に currentWallId を参照するため
  // ウォールごとに作り直す必要がない)。
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
  el.clearAllSlot.appendChild(clearAllInlineBtn);

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

  el.termAddBtn.addEventListener('click', addTerm);
  bindEnter(el.termInput, addTerm);

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

  el.backfillRunBtn.addEventListener('click', function () {
    var minutes = parseInt(el.backfillMinutes.value, 10);
    if (!minutes || minutes < 1) {
      showToast('遡る分数を 1 以上で指定してください');
      return;
    }
    var body = { minutes: minutes };
    if (el.backfillTarget.value === 'current' && currentWallId) body.wall = currentWallId;

    el.backfillRunBtn.disabled = true;
    callAdminApi('/api/admin/backfill', body)
      .then(function () {
        showToast('取り込みを開始しました');
        fetchState();
      })
      .catch(function () {
        el.backfillRunBtn.disabled = false;
        showToast('取り込みを開始できませんでした');
      });
  });

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
