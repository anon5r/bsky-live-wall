'use strict';

/**
 * Bluesky Live Wall - 会場モニター表示用スクリプト
 * ビルドツール非使用。素の ES2017+ 相当の JavaScript のみで記述する。
 *
 * サーバーとの契約 (docs/task-breakdown.md より):
 *   GET /api/stream (SSE)
 *     - hello   : { state: WallState, backlog: WallPost[], display: DisplayConfig }
 *     - post    : WallPost
 *     - profile : { did, author: WallAuthor }
 *     - remove  : { uri, reason }
 *     - state   : WallState
 *     - ping    : { t }
 */

(function () {
  // ---------------------------------------------------------------------
  // クエリパラメータによる上書き
  // ---------------------------------------------------------------------
  const params = new URLSearchParams(location.search);

  const queryOverrides = {
    columns: params.has('columns') ? parseIntSafe(params.get('columns'), null) : null,
    max: params.has('max') ? parseIntSafe(params.get('max'), null) : null,
    noimages: params.get('noimages') === '1',
    theme: params.get('theme'),
    demo: params.get('demo') === '1',
  };

  function parseIntSafe(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  if (queryOverrides.theme === 'light' || queryOverrides.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', queryOverrides.theme);
  }

  // ---------------------------------------------------------------------
  // DOM 参照
  // ---------------------------------------------------------------------
  const wallEl = document.getElementById('wall');
  const waitingEl = document.getElementById('waiting-screen');
  const waitingHashtagEl = document.getElementById('waiting-hashtag');
  const waitingHintEl = document.getElementById('waiting-hint');
  const titleEl = document.getElementById('event-title');
  const subtitleEl = document.getElementById('event-subtitle');
  const hashtagsEl = document.getElementById('hashtags');
  const statDisplayedEl = document.getElementById('stat-displayed');
  const statusDotEl = document.getElementById('status-dot');
  const statusTextEl = document.getElementById('status-text');
  const clockEl = document.getElementById('clock');
  const newPostsEl = document.getElementById('new-posts');
  const newPostsCountEl = document.getElementById('new-posts-count');

  // ---------------------------------------------------------------------
  // アプリ状態
  // ---------------------------------------------------------------------
  const state = {
    display: {
      maxCards: 40,
      columns: 1,
      cardTtlSec: 0,
      showImages: true,
    },
    hashtags: [],
    paused: false,
    // uri -> { post, el, timeEl }
    cards: new Map(),
    // 表示順 (先頭 = 最新)
    order: [],
    // スクロール中に届いた未読の新着件数
    unseen: 0,
    // 一定時間操作がなければ先頭へ戻すタイマー
    autoReturnTimer: null,
  };

  /**
   * 表示するウォールを決める。
   * `/wall/<id>` のパス、なければ `?wall=<id>` を見る。どちらも無ければ既定ウォール。
   */
  function resolveWallId() {
    const fromPath = location.pathname.replace(/^\/wall\/?/, '').replace(/\/$/, '');
    if (fromPath) return decodeURIComponent(fromPath);
    return params.get('wall') || '';
  }

  const wallId = resolveWallId();

  function streamUrl() {
    return '/api/stream' + (wallId ? '?wall=' + encodeURIComponent(wallId) : '');
  }

  function applyDisplayConfig(display) {
    if (!display) return;
    state.display = Object.assign({}, state.display, display);

    if (queryOverrides.columns) {
      state.display.columns = queryOverrides.columns;
    }
    if (queryOverrides.max) {
      state.display.maxCards = queryOverrides.max;
    }
    if (queryOverrides.noimages) {
      state.display.showImages = false;
    }

    const columns = state.display.columns || 1;
    document.documentElement.style.setProperty('--columns', String(columns));
    // 1 カラム (縦に流れる既定) では 1 行が長くなりすぎないよう中央に幅を絞る。
    // 複数カラム指定時は画面幅いっぱいを使う。
    document.documentElement.style.setProperty(
      '--stream-max-width',
      columns === 1 ? 'min(94vw, 1700px)' : '100%'
    );
  }

  applyDisplayConfig(state.display);

  // ---------------------------------------------------------------------
  // ユーティリティ: エスケープ & 本文のハイライト
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 本文中の URL / #ハッシュタグ をアクセントカラーで色分けする。
  // 生テキストをトークンに分割してからそれぞれ escapeHtml() するため、
  // ユーザー入力が未エスケープのまま innerHTML に渡ることはない。
  function renderPostTextHtml(text) {
    const pattern = /(https?:\/\/[^\s]+)|(#[\p{L}\p{N}_]+)/gu;
    let lastIndex = 0;
    let html = '';
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        html += escapeHtml(text.slice(lastIndex, match.index));
      }
      if (match[1]) {
        html += '<span class="hl-url">' + escapeHtml(match[1]) + '</span>';
      } else if (match[2]) {
        html += '<span class="hl-tag">' + escapeHtml(match[2]) + '</span>';
      }
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
      html += escapeHtml(text.slice(lastIndex));
    }
    return html;
  }

  function formatRelativeTime(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (diffSec < 10) return 'たった今';
    if (diffSec < 60) return diffSec + '秒前';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + '分前';
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return diffHour + '時間前';
    const diffDay = Math.floor(diffHour / 24);
    return diffDay + '日前';
  }

  // ---------------------------------------------------------------------
  // カード生成
  // ---------------------------------------------------------------------
  function buildCardElement(post) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.uri = post.uri;
    card.dataset.did = post.did;

    // --- ヘッダー (アバター + 名前) ---
    const head = document.createElement('div');
    head.className = 'card-head';

    const author = post.author || {};
    const handle = author.handle || '';
    const displayName = author.displayName || handle || '(不明なユーザー)';

    if (author.avatar) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = author.avatar;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        // アバター取得失敗時はプレースホルダーに差し替える
        const fallback = buildAvatarFallback(handle);
        img.replaceWith(fallback);
      });
      head.appendChild(img);
    } else {
      head.appendChild(buildAvatarFallback(handle));
    }

    const nameBlock = document.createElement('div');
    nameBlock.className = 'name-block';

    const nameEl = document.createElement('div');
    nameEl.className = 'display-name';
    nameEl.textContent = displayName;

    const handleEl = document.createElement('div');
    handleEl.className = 'handle';
    handleEl.textContent = handle ? '@' + handle : '';

    nameBlock.appendChild(nameEl);
    nameBlock.appendChild(handleEl);
    head.appendChild(nameBlock);
    card.appendChild(head);

    // --- 本文 ---
    const body = document.createElement('div');
    body.className = 'post-body';
    body.innerHTML = renderPostTextHtml(post.text || '');
    card.appendChild(body);

    // --- 画像 ---
    if (state.display.showImages && Array.isArray(post.images) && post.images.length > 0) {
      const grid = document.createElement('div');
      const count = Math.min(post.images.length, 4);
      grid.className = 'image-grid count-' + count;
      post.images.slice(0, 4).forEach((image) => {
        const img = document.createElement('img');
        img.src = image.thumb;
        img.alt = image.alt || '';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
          img.remove();
          if (!grid.childElementCount) grid.remove();
        });
        grid.appendChild(img);
      });
      card.appendChild(grid);
    }

    // --- フッター (相対時刻) ---
    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const timeEl = document.createElement('span');
    timeEl.className = 'time';
    timeEl.textContent = formatRelativeTime(post.createdAt);
    foot.appendChild(timeEl);
    card.appendChild(foot);

    return { card, timeEl, nameEl, handleEl, avatarHost: head };
  }

  function buildAvatarFallback(handle) {
    const el = document.createElement('div');
    el.className = 'avatar-fallback';
    const initial = (handle || '?').replace(/^@/, '').charAt(0).toUpperCase();
    el.textContent = initial || '?';
    return el;
  }

  // ---------------------------------------------------------------------
  // カードの追加・削除
  // ---------------------------------------------------------------------
  function addPost(post) {
    if (!post || !post.uri) return;
    if (state.cards.has(post.uri)) return; // 重複防止

    const { card, timeEl } = buildCardElement(post);
    // 利用者が過去の投稿を読むためにスクロールしている最中は、
    // 新着が入っても読んでいる位置がずれないように補正する。
    const stick = isAtTop();
    wallEl.insertBefore(card, wallEl.firstChild);
    if (!stick) {
      wallEl.scrollTop += card.offsetHeight + getCardGap();
      state.unseen += 1;
      updateNewPostsIndicator();
    }

    state.cards.set(post.uri, { post, el: card, timeEl });
    state.order.unshift(post.uri);

    enforceMaxCards();
    updateWaitingScreen();
  }

  // ---------------------------------------------------------------------
  // スクロール (会場係が過去の投稿を遡って確認するため)
  // ---------------------------------------------------------------------
  /** この範囲内なら「先頭にいる」とみなし、新着で自動的に追従する。 */
  const STICK_THRESHOLD_PX = 12;
  /** 最後の操作からこの時間が過ぎたら自動で先頭へ戻る。 */
  const AUTO_RETURN_MS = 60_000;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function isAtTop() {
    return wallEl.scrollTop <= STICK_THRESHOLD_PX;
  }

  function getCardGap() {
    const gap = parseFloat(getComputedStyle(wallEl).rowGap);
    return Number.isFinite(gap) ? gap : 0;
  }

  function scrollToTop(smooth) {
    wallEl.scrollTo({ top: 0, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
    state.unseen = 0;
    updateNewPostsIndicator();
  }

  function updateNewPostsIndicator() {
    const show = state.unseen > 0 && !isAtTop();
    newPostsEl.classList.toggle('visible', show);
    if (show) {
      newPostsCountEl.textContent = String(state.unseen);
    }
  }

  function scheduleAutoReturn() {
    if (state.autoReturnTimer) clearTimeout(state.autoReturnTimer);
    state.autoReturnTimer = setTimeout(() => {
      if (!isAtTop()) scrollToTop(true);
    }, AUTO_RETURN_MS);
  }

  wallEl.addEventListener('scroll', () => {
    if (isAtTop()) {
      state.unseen = 0;
      if (state.autoReturnTimer) {
        clearTimeout(state.autoReturnTimer);
        state.autoReturnTimer = null;
      }
    } else {
      scheduleAutoReturn();
    }
    updateNewPostsIndicator();
  });

  newPostsEl.addEventListener('click', () => scrollToTop(true));

  /**
   * 過去の投稿を既存カードの下へ積む。
   * posts は新しい順で渡されるため、その順に末尾へ追加すれば時系列が保たれる。
   * スクロール位置は変えない (下に足すだけなので読んでいる位置に影響しない)。
   */
  function appendHistory(posts) {
    let appended = 0;
    for (const post of posts) {
      if (!post || !post.uri) continue;
      if (state.cards.has(post.uri)) continue;
      if (state.order.length + appended >= (state.display.maxCards || 40)) break;

      const { card, timeEl } = buildCardElement(post);
      card.classList.add('card-history');
      wallEl.appendChild(card);
      state.cards.set(post.uri, { post, el: card, timeEl });
      state.order.push(post.uri);
      appended += 1;
    }
    if (appended > 0) {
      enforceMaxCards();
      updateWaitingScreen();
    }
  }

  function enforceMaxCards() {
    const max = state.display.maxCards || 40;
    while (state.order.length > max) {
      const uri = state.order.pop();
      const entry = state.cards.get(uri);
      if (entry) {
        entry.el.remove();
        state.cards.delete(uri);
      }
    }
  }

  function removePost(uri, immediate) {
    const entry = state.cards.get(uri);
    if (!entry) return;

    state.cards.delete(uri);
    const idx = state.order.indexOf(uri);
    if (idx !== -1) state.order.splice(idx, 1);

    if (immediate) {
      entry.el.remove();
      updateWaitingScreen();
      return;
    }

    entry.el.classList.add('card-removing');
    const cleanup = () => {
      entry.el.remove();
      updateWaitingScreen();
    };
    entry.el.addEventListener('animationend', cleanup, { once: true });
    // prefers-reduced-motion 等でアニメーションが発火しない場合の保険
    setTimeout(cleanup, 600);
  }

  function updateProfile(did, author) {
    for (const [uri, entry] of state.cards) {
      if (entry.post.did !== did) continue;
      entry.post.author = Object.assign({}, entry.post.author, author);
      const displayName = author.displayName || author.handle || entry.post.author.handle;
      const nameEl = entry.el.querySelector('.display-name');
      const handleEl = entry.el.querySelector('.handle');
      if (nameEl && displayName) nameEl.textContent = displayName;
      if (handleEl && author.handle) handleEl.textContent = '@' + author.handle;

      if (author.avatar) {
        const head = entry.el.querySelector('.card-head');
        const existingImg = head.querySelector('img.avatar');
        const existingFallback = head.querySelector('.avatar-fallback');
        if (!existingImg) {
          const img = document.createElement('img');
          img.className = 'avatar';
          img.src = author.avatar;
          img.alt = '';
          img.loading = 'lazy';
          img.addEventListener('error', () => {
            img.replaceWith(buildAvatarFallback(author.handle));
          });
          if (existingFallback) existingFallback.replaceWith(img);
          else head.insertBefore(img, head.firstChild);
        } else {
          existingImg.src = author.avatar;
        }
      }
    }
  }

  function clearAllCards() {
    wallEl.innerHTML = '';
    wallEl.scrollTop = 0;
    state.unseen = 0;
    updateNewPostsIndicator();
    state.cards.clear();
    state.order = [];
    updateWaitingScreen();
  }

  function updateWaitingScreen() {
    const empty = state.order.length === 0;
    waitingEl.classList.toggle('visible', empty);
  }

  // ---------------------------------------------------------------------
  // ヘッダー表示の更新
  // ---------------------------------------------------------------------
  /**
   * 監視対象をヘッダに並べる。
   * terms が来ていればハッシュタグとキーワードを区別して表示し、
   * 古い形式 (hashtags のみ) でも動くようにフォールバックする。
   */
  function renderHashtags(tags, terms) {
    const list = Array.isArray(terms) && terms.length > 0
      ? terms
      : (tags || []).map((t) => ({ value: t, type: 'hashtag' }));

    hashtagsEl.replaceChildren();
    list.forEach((term) => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill tag-pill-' + term.type;
      pill.textContent =
        term.type === 'hashtag'
          ? (term.value.startsWith('#') ? term.value : '#' + term.value)
          : term.value;
      hashtagsEl.appendChild(pill);
    });

    // 待機画面には、投稿者に付けてもらう必要があるハッシュタグだけを出す。
    // キーワードは投稿者に入力を促すものではないため含めない。
    renderWaitingScreen(list.filter((t) => t.type === 'hashtag').map((t) => t.value));
  }

  // 待機画面はハッシュタグ本体と補助メッセージを分けて描画する。
  // ハッシュタグは会場後方からでも読み取れるよう最大級の文字とアクセント色にする。
  function renderWaitingScreen(tags) {
    waitingHashtagEl.replaceChildren();
    const normalized = tags.map((t) => (t.startsWith('#') ? t : '#' + t));

    if (normalized.length === 0) {
      waitingHintEl.textContent = 'ハッシュタグが設定されていません';
      return;
    }

    normalized.forEach((tag) => {
      const item = document.createElement('span');
      item.className = 'waiting-hashtag-item';
      item.textContent = tag;
      waitingHashtagEl.appendChild(item);
    });

    waitingHintEl.textContent =
      normalized.length === 1
        ? 'このハッシュタグをつけて投稿すると、この画面に表示されます'
        : 'いずれかのハッシュタグをつけて投稿すると、この画面に表示されます';
  }

  function applyWallState(wallState) {
    if (!wallState) return;

    if (wallState.eventTitle) titleEl.textContent = wallState.eventTitle;
    // 複数ウォール運用では、どのウォールを映しているかが分かるようにする。
    const parts = [];
    if (wallState.wallName && wallState.wallName !== wallState.eventTitle) {
      parts.push(wallState.wallName);
    }
    if (wallState.eventSubtitle) parts.push(wallState.eventSubtitle);
    subtitleEl.textContent = parts.join(' / ');

    if (Array.isArray(wallState.hashtags)) {
      state.hashtags = wallState.hashtags;
      renderHashtags(wallState.hashtags, wallState.terms);
    }

    state.paused = !!wallState.paused;
    if (state.paused) {
      statusTextEl.dataset.paused = '1';
    } else {
      delete statusTextEl.dataset.paused;
    }

    if (wallState.stats && typeof wallState.stats.displayed === 'number') {
      statDisplayedEl.textContent = String(wallState.stats.displayed);
    }

    // 接続状態自体は connection.js 側のロジックで上書きされるため、
    // ここでは一時停止のテキスト装飾のみ反映する。
    refreshStatusText();
  }

  // ---------------------------------------------------------------------
  // 接続ステータス管理
  // ---------------------------------------------------------------------
  const connection = {
    es: null,
    status: 'connecting', // connecting | connected | disconnected
    reconnectDelay: 1000,
    maxReconnectDelay: 10000,
    lastMessageAt: Date.now(),
    watchdogTimer: null,
    reconnectTimer: null,
  };

  const WATCHDOG_INTERVAL_MS = 45000;

  function setStatus(status) {
    connection.status = status;
    statusDotEl.classList.remove('status-connected', 'status-connecting', 'status-disconnected');
    if (status === 'connected') {
      statusDotEl.classList.add('status-connected');
    } else if (status === 'connecting') {
      statusDotEl.classList.add('status-connecting');
    } else {
      statusDotEl.classList.add('status-disconnected');
    }
    refreshStatusText();
  }

  function refreshStatusText() {
    let text;
    if (connection.status === 'connected') text = '接続中';
    else if (connection.status === 'connecting') text = '再接続中';
    else text = '切断';

    if (state.paused) text += '（一時停止中）';
    statusTextEl.textContent = text;
  }

  function scheduleReconnect() {
    setStatus('connecting');
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = setTimeout(() => {
      connectStream();
    }, connection.reconnectDelay);
    connection.reconnectDelay = Math.min(connection.reconnectDelay * 2, connection.maxReconnectDelay);
  }

  function resetWatchdog() {
    connection.lastMessageAt = Date.now();
  }

  function startWatchdog() {
    clearInterval(connection.watchdogTimer);
    connection.watchdogTimer = setInterval(() => {
      if (Date.now() - connection.lastMessageAt > WATCHDOG_INTERVAL_MS) {
        // 一定時間ノーレスポンス -> 強制再接続
        forceReconnect();
      }
    }, 5000);
  }

  function forceReconnect() {
    if (connection.es) {
      connection.es.close();
      connection.es = null;
    }
    setStatus('disconnected');
    scheduleReconnect();
  }

  function connectStream() {
    if (queryOverrides.demo) return; // デモモードでは SSE 接続しない

    clearTimeout(connection.reconnectTimer);
    if (connection.es) {
      connection.es.close();
      connection.es = null;
    }

    setStatus('connecting');

    let es;
    try {
      es = new EventSource(streamUrl());
    } catch (err) {
      scheduleReconnect();
      return;
    }
    connection.es = es;

    es.addEventListener('open', () => {
      connection.reconnectDelay = 1000;
      resetWatchdog();
      setStatus('connected');
    });

    es.addEventListener('error', () => {
      setStatus('disconnected');
      if (es.readyState === EventSource.CLOSED) {
        connection.es = null;
        scheduleReconnect();
      }
    });

    es.addEventListener('hello', (ev) => {
      resetWatchdog();
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      // 再接続時は既存 DOM をリセットしてから backlog で再構築する
      clearAllCards();
      applyDisplayConfig(payload.display);
      applyWallState(payload.state);
      const backlog = Array.isArray(payload.backlog) ? payload.backlog : [];
      // backlog は古い順で届く想定。addPost は先頭挿入なので古い順のまま処理すれば
      // 結果として新しいものが先頭に来る。
      backlog.forEach((post) => addPost(post));
    });

    // 起動時バックフィルで確定した過去の投稿。既存カードより下へ積む。
    es.addEventListener('history', (ev) => {
      resetWatchdog();
      try {
        const posts = JSON.parse(ev.data);
        if (Array.isArray(posts)) appendHistory(posts);
      } catch (e) {
        /* 不正なペイロードは無視 */
      }
    });

    es.addEventListener('post', (ev) => {
      resetWatchdog();
      try {
        addPost(JSON.parse(ev.data));
      } catch (e) {
        /* 不正なペイロードは無視 */
      }
    });

    es.addEventListener('profile', (ev) => {
      resetWatchdog();
      try {
        const payload = JSON.parse(ev.data);
        updateProfile(payload.did, payload.author || {});
      } catch (e) {
        /* noop */
      }
    });

    es.addEventListener('remove', (ev) => {
      resetWatchdog();
      try {
        const payload = JSON.parse(ev.data);
        if (payload.reason === 'cleared') {
          clearAllCards();
        } else {
          removePost(payload.uri, false);
        }
      } catch (e) {
        /* noop */
      }
    });

    es.addEventListener('state', (ev) => {
      resetWatchdog();
      try {
        applyWallState(JSON.parse(ev.data));
      } catch (e) {
        /* noop */
      }
    });

    es.addEventListener('ping', () => {
      resetWatchdog();
    });
  }

  // ---------------------------------------------------------------------
  // 相対時刻・時計の定期更新
  // ---------------------------------------------------------------------
  function tickRelativeTimes() {
    for (const entry of state.cards.values()) {
      entry.timeEl.textContent = formatRelativeTime(entry.post.createdAt);
    }
  }

  function tickClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = hh + ':' + mm + ':' + ss;
  }

  setInterval(tickRelativeTimes, 10000);
  setInterval(tickClock, 1000);
  tickClock();
  updateWaitingScreen();

  // ---------------------------------------------------------------------
  // デモモード (?demo=1): サーバー未接続でも描画確認できるようにする
  // ---------------------------------------------------------------------
  function startDemoMode() {
    setStatus('connected');
    applyWallState({
      eventTitle: 'デモイベント 2026',
      eventSubtitle: 'Bluesky Live Wall 動作確認用',
      hashtags: ['#デモ', '#テスト'],
      paused: false,
      stats: { displayed: 0 },
    });
    applyDisplayConfig({ maxCards: state.display.maxCards, columns: state.display.columns, showImages: true });

    const sampleTexts = [
      'これはデモ投稿です #デモ 会場から見やすいか確認しましょう。',
      '長文のテストです。'.repeat(6) + ' #テスト https://example.com/demo',
      '絵文字も試す 🎉🚀✨ #デモ とても楽しいイベントですね！',
      '画像付き投稿のテスト表示です。 #テスト',
      'URL テスト: https://bsky.app/profile/example.bsky.social',
    ];

    let counter = 0;
    let displayed = 0;

    // 外部 CDN を使わず、インライン SVG (data URI) でダミー画像を生成する
    function demoImage(color) {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">' +
        '<rect width="100%" height="100%" fill="' + color + '"/>' +
        '</svg>';
      const dataUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      return { thumb: dataUri, fullsize: dataUri, alt: 'デモ画像' };
    }

    function randomAuthor(i) {
      return {
        did: 'did:demo:' + (i % 5),
        handle: 'demo-user-' + (i % 5) + '.bsky.social',
        displayName: 'デモユーザー ' + (i % 5),
        avatar: undefined,
      };
    }

    setInterval(() => {
      counter += 1;
      displayed += 1;
      const withImages = counter % 3 === 0;
      const post = {
        uri: 'at://did:demo:' + counter + '/app.bsky.feed.post/demo' + counter,
        cid: 'demo-cid-' + counter,
        rkey: 'demo' + counter,
        did: 'did:demo:' + (counter % 5),
        author: randomAuthor(counter),
        text: sampleTexts[counter % sampleTexts.length],
        matchedTags: ['デモ'],
        images: withImages ? [demoImage('#2f9bff'), demoImage('#6ec1ff')] : [],
        langs: ['ja'],
        isReply: false,
        createdAt: new Date().toISOString(),
        receivedAt: Date.now(),
        timeUs: Date.now() * 1000,
        webUrl: 'https://bsky.app/profile/demo/post/demo' + counter,
        status: 'visible',
      };
      addPost(post);
      statDisplayedEl.textContent = String(displayed);
    }, 3000);
  }

  // ---------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------
  if (queryOverrides.demo) {
    startDemoMode();
  } else {
    connectStream();
    startWatchdog();
  }
})();
