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
  var POLL_INTERVAL_MS = 3000;
  var CONFIRM_TIMEOUT_MS = 3000;

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
hashtagsInput: document.getElementById('hashtags-input'),
hashtagsSaveBtn: document.getElementById('hashtags-save-btn'),
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
  };

  // ---------- 状態 ----------
  var pollTimer = null;
  var currentToken = '';
  var sessionExpiresAt = 0;
  // サーバーが受け付ける認証方式。エラーメッセージの出し分けに使う。
  var authConfig = { token: true, oauth: false };
  var isPaused = false;
  var pauseRequestInFlight = false;

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
    apiFetch('/api/admin/state')
      .then(function (res) {
        if (res.status === 401) {
          handleUnauthorized();
          return null;
        }
        if (!res.ok) {
          throw new Error('サーバーエラー (' + res.status + ')');
        }
        return res.json();
      })
      .then(function (data) {
        if (data) {
          renderState(data);
        }
      })
      .catch(function (err) {
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

  // 監視設定。入力中の値を上書きしないよう、フォーカス中は書き換えない。
  function renderWatchSettings(data) {
    var state = data.state || {};
    if (document.activeElement !== el.hashtagsInput) {
      el.hashtagsInput.value = (state.hashtags || [])
        .map(function (t) { return '#' + t; })
        .join(', ');
    }

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
      meta.className = 'field-note';
      meta.textContent = info.error
        ? info.memberCount + ' 件 (最新の取得に失敗: ' + info.error + ')'
        : info.memberCount + ' 件';
      body.appendChild(meta);
      li.appendChild(body);

      var btn = document.createElement('button');
      btn.className = 'btn btn-neutral btn-small';
      btn.textContent = '購読解除';
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
      btn.textContent = 'ブロック解除';
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
      approveBtn.textContent = '承認';
      approveBtn.addEventListener('click', function () {
        callAdminApi('/api/admin/approve', { uri: post.uri })
          .then(function () { fetchState(); })
          .catch(function () { showToast('承認に失敗しました'); });
      });
      actionsRow.appendChild(approveBtn);
    }

    if (actions.hide) {
      var hideBtn = document.createElement('button');
      hideBtn.className = 'btn btn-neutral btn-small';
      hideBtn.textContent = '非表示';
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
      unhideBtn.textContent = '復元';
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
    btn.textContent = opts.label;

    var confirming = false;
    var resetTimer = null;

    function reset() {
      confirming = false;
      btn.textContent = opts.label;
      btn.classList.remove('btn-confirming');
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
    }

    btn.addEventListener('click', function () {
      if (!confirming) {
        confirming = true;
        btn.textContent = opts.confirmLabel;
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

  // ==========================================================
  // イベントハンドラ
  // ==========================================================

  el.hashtagsSaveBtn.addEventListener('click', function () {
    var tags = (el.hashtagsInput.value || '')
      .split(',')
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t.length > 0; });
    if (tags.length === 0) {
      showToast('ハッシュタグを 1 つ以上入力してください');
      return;
    }
    callAdminApi('/api/admin/hashtags', { hashtags: tags })
      .then(function () {
        showToast('監視ハッシュタグを変更しました');
        fetchState();
      })
      .catch(function () { showToast('変更に失敗しました'); });
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
      meta.className = 'field-note';
      // modlist 以外 (curatelist など) も購読はできるが、用途が違うことを示す。
      var kind = list.purpose.indexOf('modlist') >= 0 ? 'モデレーションリスト' : 'キュレーションリスト';
      meta.textContent = kind + ' / ' + list.itemCount + ' 件';
      body.appendChild(meta);
      li.appendChild(body);

      var btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-small';
      btn.textContent = '購読';
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

  el.handleInput.addEventListener('keydown', function (evt) {
    if (evt.key === 'Enter') el.oauthBtn.click();
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

  el.tokenInput.addEventListener('keydown', function (evt) {
    if (evt.key === 'Enter') {
      el.connectBtn.click();
    }
  });

  el.clearTokenBtn.addEventListener('click', function () {
    removeToken();
    el.tokenInput.value = '';
  });

  // トークンが漏れた疑いがあるときの緊急手段。自分自身もログアウトされる。
  el.revokeSessionsBtn.replaceWith(
    makeInlineConfirmButton({
      label: '全セッション失効',
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
    window.open('/wall', '_blank', 'noopener');
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
    confirmLabel: '本当に？',
    className: 'btn btn-danger',
    onConfirm: function () {
      callAdminApi('/api/admin/clear')
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
