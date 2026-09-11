<script>
  /**
   * 選択中のウォールの作業領域。
   *
   * 設定項目を 1 本の縦列に積むと、変える設定と見る情報が混ざって探しにくい。
   * 左のセクションナビで「設定」(監視語 / 承認と除外 / 会場モニター表示 /
   * ウォール管理) と「運用」(承認待ち / 直近の投稿) を分け、右には選んだ
   * セクションだけを出す。
   */
  import {
    store,
    addTerm,
    requestRemoveTerm,
    setTermApproval,
    requestDeleteWall,
    renameWall,
    clearAll,
    updateWallModeration,
    updateWallDisplay,
    setScreen,
    uploadScreenImage,
    requestRemoveScreenImage,
    SCREEN_MODE_LABELS,
    IMAGE_POSITION_LABELS,
    IMAGE_SIZE_LABELS,
    addExcludeTerm,
    requestRemoveExcludeTerm,
    setExcludePolicy,
    EXCLUDE_POLICY_LABELS,
    wallUrl,
    canEditSettings,
    WALL_MODERATION_LABELS,
    WALL_KEYWORD_APPROVAL_LABELS,
  } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';
  import TermEditor from './TermEditor.svelte';
  import PostList from './PostList.svelte';
  import InlineConfirmButton from './InlineConfirmButton.svelte';

  let { wall, section = 'terms' } = $props();

  const wallName = $derived(store.state.wallName || '-');

  const termCount = $derived((store.state.terms || []).length);
  // 件数はウォールバーのチップと同じ出どころ (ウォール一覧) を使う。
  // 一覧の取得件数 (backlogSize 上限) を出すと、隣り合う数字が食い違って見える。
  const pendingCount = $derived(wall.pendingCount || 0);
  const recentCount = $derived(wall.postCount || 0);
  const excludeTerms = $derived(wall.excludeTerms || []);
  const excludePolicy = $derived(wall.excludePolicy || 'reject');
  const moderationBadge = $derived(store.state.moderationMode === 'approve' ? '承認制' : '公開');

  // ---- 承認と除外 ----
  // ウォールの設定はオーナー (とシステム管理者) のもの。
  // モデレーターには編集 UI 自体を出さず、進行に使うものだけを残す。
  const canEditModeration = $derived(canEditSettings());
  const wallModerationMode = $derived(store.state.wallModerationMode || 'inherit');
  const wallKeywordApproval = $derived(store.state.wallKeywordRequireApproval || 'inherit');
  const tenantModerationLabel = $derived(store.state.tenantModerationMode === 'approve' ? '承認制' : '公開');
  const tenantKeywordLabel = $derived(
    store.state.tenantKeywordRequireApproval ? '承認待ちにする' : 'そのまま表示する'
  );
  const excludeSummary = $derived(
    excludeTerms.length === 0
      ? ''
      : excludePolicy === 'reject'
        ? ' 除外キーワードを含む投稿は受信した時点で捨てます。'
        : ' 除外キーワードを含む投稿は承認待ちに回します。'
  );
  const effectiveSummary = $derived(
    (store.state.moderationMode === 'approve'
      ? 'このウォールに一致した投稿はすべて承認待ちになります。'
      : store.state.keywordRequireApproval
        ? 'ハッシュタグ付きの投稿はそのまま表示し、キーワードのみ一致した投稿は承認待ちにします (語ごとの設定が優先)。'
        : '一致した投稿はそのまま表示します (語ごとに「必ず承認待ち」を指定した語を除く)。') + excludeSummary
  );
  const moderationModeNote = $derived(
    wallModerationMode === 'inherit'
      ? 'テナント設定に従っています (現在: ' + tenantModerationLabel + ')。'
      : wallModerationMode === 'open'
        ? 'このウォールだけ公開にしています。'
        : 'このウォールに一致した投稿はすべて承認待ちです。'
  );
  const keywordApprovalNote = $derived(
    store.state.moderationMode === 'approve'
      ? '承認モードが優先されるため、この設定は効きません。'
      : wallKeywordApproval === 'inherit'
        ? 'テナント設定に従っています (現在: ' + tenantKeywordLabel + ')。'
        : wallKeywordApproval === 'always'
          ? 'ハッシュタグの付かない一致は承認待ちにします。'
          : '意図して設定した語として、そのまま表示します。'
  );

  function onWallModeChange(evt) {
    const next = evt.target && evt.target.value;
    if (!next || next === wallModerationMode) return;
    updateWallModeration(wall.id, { moderationMode: next });
  }

  function onWallKeywordApprovalChange(evt) {
    const next = evt.target && evt.target.value;
    if (!next || next === wallKeywordApproval) return;
    updateWallModeration(wall.id, { keywordRequireApproval: next });
  }

  let excludeInputEl = $state(null);

  function submitExclude() {
    const raw = (excludeInputEl && excludeInputEl.value) || '';
    const ok = addExcludeTerm(wall, raw);
    if (ok !== false && excludeInputEl) {
      excludeInputEl.value = '';
      try {
        excludeInputEl.focus();
      } catch {
        // フォーカスできなくても致命的ではない
      }
    }
    return ok;
  }

  function onExcludePolicyChange(evt) {
    const next = evt.target && evt.target.value;
    if (!next || next === excludePolicy) return;
    setExcludePolicy(next);
  }

  // ---- 会場モニターの表示設定 ----
  const showClock = $derived(wall.display ? wall.display.showClock !== false : true);
  const showSeconds = $derived(wall.display ? wall.display.showSeconds !== false : true);
  const showTerms = $derived(wall.display ? wall.display.showTerms !== false : true);
  const showKeywords = $derived(wall.display ? wall.display.showKeywords === true : false);

  let clockSwitchEl = $state(null);
  let secondsSwitchEl = $state(null);
  let termsSwitchEl = $state(null);
  let keywordsSwitchEl = $state(null);

  // wa-switch は checked をプロパティで持つため、状態が変わるたびに反映する。
  $effect(() => {
    if (clockSwitchEl) clockSwitchEl.checked = showClock;
  });
  $effect(() => {
    if (secondsSwitchEl) secondsSwitchEl.checked = showSeconds;
  });
  $effect(() => {
    if (termsSwitchEl) termsSwitchEl.checked = showTerms;
  });
  $effect(() => {
    if (keywordsSwitchEl) keywordsSwitchEl.checked = showKeywords;
  });

  function onClockToggle() {
    updateWallDisplay(wall.id, { showClock: !!(clockSwitchEl && clockSwitchEl.checked) });
  }

  function onSecondsToggle() {
    updateWallDisplay(wall.id, { showSeconds: !!(secondsSwitchEl && secondsSwitchEl.checked) });
  }

  function onTermsToggle() {
    updateWallDisplay(wall.id, { showTerms: !!(termsSwitchEl && termsSwitchEl.checked) });
  }

  function onKeywordsToggle() {
    updateWallDisplay(wall.id, { showKeywords: !!(keywordsSwitchEl && keywordsSwitchEl.checked) });
  }

  // ---- 画面モード ----
  const screen = $derived(store.state.screen || { mode: 'wall' });
  const screenMode = $derived(screen.mode || 'wall');
  const screenImageUrl = $derived(store.state.screenImageUrl || null);

  let imageInputEl = $state(null);
  let autoResumeSwitchEl = $state(null);
  let showImageSwitchEl = $state(null);

  $effect(() => {
    if (autoResumeSwitchEl) autoResumeSwitchEl.checked = screen.autoResume !== false;
  });
  $effect(() => {
    if (showImageSwitchEl) showImageSwitchEl.checked = screen.showImage === true;
  });

  function pickMode(mode) {
    if (mode === screenMode) return;
    setScreen({ mode }, SCREEN_MODE_LABELS[mode] + ' に切り替えました');
  }

  // 文言は入力が終わった時点 (change) で保存する。打っている途中で保存しない。
  function onScreenText(key, evt) {
    const value = (evt.target && evt.target.value) || '';
    if (value === (screen[key] || '')) return;
    setScreen({ [key]: value }, '文言を保存しました');
  }

  function onAutoResumeToggle() {
    setScreen({ autoResume: !!(autoResumeSwitchEl && autoResumeSwitchEl.checked) });
  }

  function onShowImageToggle() {
    setScreen({ showImage: !!(showImageSwitchEl && showImageSwitchEl.checked) });
  }

  function onImagePositionChange(evt) {
    const next = evt.target && evt.target.value;
    if (next) setScreen({ imagePosition: next });
  }

  function onImageSizeChange(evt) {
    const next = evt.target && evt.target.value;
    if (next) setScreen({ imageSize: next });
  }

  function onImageCaptionChange(evt) {
    onScreenText('imageCaption', evt);
  }

  function onImagePick(evt) {
    const file = evt.target && evt.target.files && evt.target.files[0];
    if (file) uploadScreenImage(file);
    if (imageInputEl) imageInputEl.value = '';
  }

  /** プレビューに出す見出し・補足。会場モニターと同じ決め方にする。 */
  const previewText = $derived.by(() => {
    if (screenMode === 'break') {
      return { headline: screen.breakHeadline || '休憩中', badge: screen.breakNote || '', hint: '' };
    }
    if (screenMode === 'ended') {
      return {
        headline: screen.endedHeadline || '本日はありがとうございました',
        badge: (store.state.hashtags || []).map((t) => '#' + t).join('  '),
        hint: screen.endedNote || '',
      };
    }
    return {
      headline: screen.waitingHeadline || '投稿を待っています…',
      badge: (store.state.hashtags || []).map((t) => '#' + t).join('  '),
      hint: screen.waitingHint || 'このタグをつけて投稿すると、この画面に表示されます',
    };
  });

  // ヘッダのプレビューに出す監視語 (会場モニターと同じ絞り込み)。
  const previewTerms = $derived(
    showTerms ? (store.state.terms || []).filter((t) => t.type !== 'keyword' || showKeywords) : []
  );

  // ---- 改名 ----
  let renaming = $state(false);
  let renameInputEl = $state(null);
  // 改名の初期値。3 秒ごとのポーリングで再描画されても入力中の値を
  // 上書きしないよう、リアクティブではない素の変数として持つ。
  let renameInitialName = '';

  function startRename() {
    renameInitialName = wall.name;
    renaming = true;
  }

  function cancelRename() {
    renaming = false;
  }

  async function submitRename() {
    const value = (renameInputEl && renameInputEl.value) || '';
    const ok = await renameWall(wall, value);
    if (ok) renaming = false;
  }

  function onRenameSubmit(evt) {
    evt.preventDefault();
    submitRename();
  }

  $effect(() => {
    if (renaming && renameInputEl) {
      // レンダリングと同じフラッシュ内で行うとタイミング次第で内部要素が
      // まだ用意できておらず例外になることがあるため、次のフレームに回す。
      // 値もここで一度だけ入れる (テンプレートの value 束縛にすると
      // ポーリングのたびに再適用され、入力途中の文字が消える)。
      const el = renameInputEl;
      const initial = renameInitialName;
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        try {
          el.value = initial;
          el.focus();
          el.select();
        } catch {
          // フォーカスできなくても致命的ではない
        }
      });
    }
  });
</script>

<div class="wall-section-body">
  <!-- セクション本体 -->
    {#if section === 'terms'}
      <header class="wall-section-head">
        <h2>
          監視語
          <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール単位</span>
        </h2>
        <p>このウォール「{wallName}」が拾う語。合計 20 件まで。</p>
      </header>

      <section class="panel">
        <TermEditor
          terms={store.state.terms || []}
          onAdd={(raw, isKeyword) => addTerm(raw, isKeyword)}
          onRemove={(term) => requestRemoveTerm(term)}
          onApprovalChange={canEditModeration ? (term, next) => setTermApproval(term, next) : null}
          readonly={!canEditModeration}
          showKeywordWarning={true}
          addLabel="追加"
        />
      </section>
      {#if !canEditModeration}
        <p class="field-note">監視語を変更できるのはオーナーだけです。ここでは何を拾っているかだけ確認できます。</p>
      {/if}
    {:else if section === 'moderation'}
      <header class="wall-section-head">
        <h2>
          承認と除外
          <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール単位</span>
        </h2>
        <p>拾った投稿を会場モニターへ出すまでの関門。上から順に優先します。</p>
      </header>

      <!-- 継承を解決した結果を 1 枚にまとめる -->
      <div class="summary-card">
        <i class="fa-solid fa-circle-info fa-fw" aria-hidden="true"></i>
        <div>
          <p class="summary-card-title">いまの動作</p>
          <p class="summary-card-body">{effectiveSummary}</p>
        </div>
      </div>

      <section class="panel">
        <div class="control-row">
          <span class="control-label">
            承認モード
            <span class="control-note">{moderationModeNote}</span>
          </span>
          <wa-select
            size="s"
            class="moderation-select"
            value={wallModerationMode}
            aria-label="このウォールの承認モード"
            disabled={!canEditModeration}
            onchange={onWallModeChange}
          >
            {#each Object.keys(WALL_MODERATION_LABELS) as key (key)}
              <wa-option value={key}>{WALL_MODERATION_LABELS[key]}</wa-option>
            {/each}
          </wa-select>
        </div>

        <div class="control-row">
          <span class="control-label">
            キーワードのみ一致した投稿
            <span class="control-note">{keywordApprovalNote}</span>
          </span>
          <wa-select
            size="s"
            class="moderation-select"
            value={wallKeywordApproval}
            aria-label="キーワードのみ一致した投稿の扱い"
            disabled={!canEditModeration}
            onchange={onWallKeywordApprovalChange}
          >
            {#each Object.keys(WALL_KEYWORD_APPROVAL_LABELS) as key (key)}
              <wa-option value={key}>{WALL_KEYWORD_APPROVAL_LABELS[key]}</wa-option>
            {/each}
          </wa-select>
        </div>

        <div class="control-row control-row-stacked">
          <div class="control-row-main">
            <span class="control-label">
              除外キーワード
              <span class="panel-count">{excludeTerms.length}</span>
              <span class="control-note">
                含む投稿は監視語に一致しても拾いません。会場モニターへは送りません。
              </span>
            </span>
            <wa-select
              size="s"
              class="moderation-select"
              value={excludePolicy}
              aria-label="除外キーワードに一致した投稿の扱い"
              onchange={onExcludePolicyChange}
            >
              {#each Object.keys(EXCLUDE_POLICY_LABELS) as key (key)}
                <wa-option value={key}>{EXCLUDE_POLICY_LABELS[key]}</wa-option>
              {/each}
            </wa-select>
          </div>

          <div class="exclude-row">
            <ul class="term-list exclude-list">
              {#each excludeTerms as term (term.value)}
                <li class="term-item">
                  <wa-tag
                    with-remove
                    variant="danger"
                    aria-label={'除外キーワード ' + term.value + ' を外す'}
                    onwa-remove={() => requestRemoveExcludeTerm(wall, term)}
                  >
                    <i class="fa-solid fa-ban" aria-hidden="true"></i>
                    {term.value}
                  </wa-tag>
                </li>
              {/each}
            </ul>
            <div class="field-row exclude-add">
              <wa-input
                id="exclude-input"
                size="s"
                bind:this={excludeInputEl}
                autocomplete="off"
                placeholder="本文に含まれていたら拾わない語"
                aria-label="除外キーワードを追加"
                use:enterKey={submitExclude}
              ></wa-input>
              <wa-button size="s" variant="danger" appearance="outlined" onclick={submitExclude}>
                <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> 追加
              </wa-button>
            </div>
          </div>
        </div>
      </section>

      <p class="field-note">
        却下した投稿は「非表示にした投稿」に残しません。同じ文面を運営が見続けずに済むようにするためです。
        承認が不要になる向きに設定を変えると、溜まっていた承認待ちはその場で表示へ移ります。
        {#if !canEditModeration}承認モードを変更できるのはオーナーだけです。{/if}
      </p>
    {:else if section === 'monitor'}
      <header class="wall-section-head">
        <h2>
          会場モニター
          <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール単位</span>
        </h2>
        <p>モードと表示要素をここでまとめて設定します。変更はプレビューと会場モニターにすぐ反映されます。</p>
      </header>

      <!-- モード切り替え + プレビュー -->
      <div class="monitor-preview monitor-preview-full">
        <div class="monitor-modes">
          <span class="monitor-modes-label">いまのモード</span>
          {#each Object.keys(SCREEN_MODE_LABELS) as mode (mode)}
            <button
              type="button"
              class={'monitor-mode-btn' + (screenMode === mode ? ' is-active' : '')}
              aria-pressed={screenMode === mode}
              onclick={() => pickMode(mode)}
            >
              {SCREEN_MODE_LABELS[mode]}
            </button>
          {/each}
        </div>

        <div class="monitor-screen">
          <div class="monitor-preview-bar">
            <div class="monitor-preview-title">
              {#if store.state.showBlueskyLogo !== false}
                <svg class="monitor-preview-logo" viewBox="0 0 576 512" aria-hidden="true">
                  <path
                    fill="#0085ff"
                    d="M407.8 294.7c-3.3-.4-6.7-.8-10-1.3 3.4 .4 6.7 .9 10 1.3zM288 227.1C261.9 176.4 190.9 81.9 124.9 35.3 61.6-9.4 37.5-1.7 21.6 5.5 3.3 13.8 0 41.9 0 58.4S9.1 194 15 213.9c19.5 65.7 89.1 87.9 153.2 80.7 3.3-.5 6.6-.9 10-1.4-3.3 .5-6.6 1-10 1.4-93.9 14-177.3 48.2-67.9 169.9 120.3 124.6 164.8-26.7 187.7-103.4 22.9 76.7 49.2 222.5 185.6 103.4 102.4-103.4 28.1-156-65.8-169.9-3.3-.4-6.7-.8-10-1.3 3.4 .4 6.7 .9 10 1.3 64.1 7.1 133.6-15.1 153.2-80.7 5.9-19.9 15-138.9 15-155.5s-3.3-44.7-21.6-52.9c-15.8-7.1-40-14.9-103.2 29.8-66.1 46.6-137.1 141.1-163.2 191.8z"
                  ></path>
                </svg>
              {/if}
              <span>{store.state.eventTitle || 'Live Wall'}</span>
            </div>
            <div class="monitor-preview-tags">
              {#each previewTerms.slice(0, 4) as term (term.type + ':' + term.value)}
                <span class={'monitor-preview-pill monitor-preview-pill-' + term.type}>
                  {term.type === 'hashtag' ? '#' + term.value : term.value}
                </span>
              {/each}
            </div>
            {#if showClock}
              <div class="monitor-preview-clock">
                <span class="monitor-preview-hm">12:34</span>
                {#if showSeconds}<span class="monitor-preview-sec">08</span>{/if}
              </div>
            {/if}
          </div>

          <div class="monitor-screen-body">
            {#if screenMode === 'wall'}
              <!-- 通常モードは投稿カードのモックで見せる -->
              <div class="monitor-cards">
                {#each (store.recent || []).slice(0, 3) as post (post.uri)}
                  <div class="monitor-card">
                    <span class="monitor-card-avatar"></span>
                    <div class="monitor-card-body">
                      <span class="monitor-card-name">{(post.author && (post.author.displayName || post.author.handle)) || '投稿者'}</span>
                      <p class="monitor-card-text">{post.text}</p>
                    </div>
                  </div>
                {:else}
                  <div class="monitor-card monitor-card-empty">
                    <span class="monitor-card-avatar"></span>
                    <div class="monitor-card-body">
                      <span class="monitor-card-name">投稿がここに流れます</span>
                      <p class="monitor-card-text">投稿が 1 件も無いときは待機画面に切り替わります。</p>
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="monitor-message">
                <p class="monitor-message-headline">{previewText.headline}</p>
                {#if previewText.badge}
                  <p class={'monitor-message-badge' + (screenMode === 'break' ? ' is-break' : '')}>{previewText.badge}</p>
                {/if}
                {#if previewText.hint}
                  <p class="monitor-message-hint">{previewText.hint}</p>
                {/if}
              </div>
            {/if}

            {#if screenMode !== 'wall' && screen.showImage && screenImageUrl}
              <div class={'monitor-image monitor-image-' + (screen.imagePosition || 'bottom-right')}>
                <img src={screenImageUrl} alt="" />
                {#if screen.imageCaption}
                  <span class="monitor-image-caption">{screen.imageCaption}</span>
                {/if}
              </div>
            {/if}
          </div>
        </div>
        <p class="monitor-preview-caption">会場モニターのプレビュー。下の設定を変えるとここに反映されます。</p>
      </div>

      <!-- モードごとの文言 (オーナーのみ) -->
      {#if canEditModeration && screenMode !== 'wall'}
        <section class="panel">
          {#if screenMode === 'waiting'}
            <div class="control-row">
              <span class="control-label">
                待機中の見出し
                <span class="control-note">ハッシュタグを案内する文言にすると迷いません。</span>
              </span>
              <wa-input
                size="s"
                class="settings-input"
                value={screen.waitingHeadline || ''}
                aria-label="待機中の見出し"
                onchange={(evt) => onScreenText('waitingHeadline', evt)}
              ></wa-input>
            </div>
            <div class="control-row">
              <span class="control-label">
                待機中の補足
                <span class="control-note">見出しとハッシュタグの下に小さく出ます。</span>
              </span>
              <wa-input
                size="s"
                class="settings-input"
                value={screen.waitingHint || ''}
                aria-label="待機中の補足"
                onchange={(evt) => onScreenText('waitingHint', evt)}
              ></wa-input>
            </div>
            <div class="control-row">
              <span class="control-label">
                投稿が届いたら通常へ戻す
                <span class="control-note">待機モードのときだけ効きます。</span>
              </span>
              <wa-switch bind:this={autoResumeSwitchEl} onchange={onAutoResumeToggle}></wa-switch>
            </div>
          {:else if screenMode === 'break'}
            <div class="control-row">
              <span class="control-label">休憩中の見出し</span>
              <wa-input
                size="s"
                class="settings-input"
                value={screen.breakHeadline || ''}
                aria-label="休憩中の見出し"
                onchange={(evt) => onScreenText('breakHeadline', evt)}
              ></wa-input>
            </div>
            <div class="control-row">
              <span class="control-label">
                再開予定
                <span class="control-note">空なら出しません。例: 14:30 再開</span>
              </span>
              <wa-input
                size="s"
                class="settings-input"
                value={screen.breakNote || ''}
                aria-label="再開予定"
                onchange={(evt) => onScreenText('breakNote', evt)}
              ></wa-input>
            </div>
          {:else}
            <div class="control-row">
              <span class="control-label">終演の見出し</span>
              <wa-input
                size="s"
                class="settings-input"
                value={screen.endedHeadline || ''}
                aria-label="終演の見出し"
                onchange={(evt) => onScreenText('endedHeadline', evt)}
              ></wa-input>
            </div>
            <div class="control-row">
              <span class="control-label">
                終演の補足
                <span class="control-note">アーカイブの案内など。</span>
              </span>
              <wa-input
                size="s"
                class="settings-input"
                value={screen.endedNote || ''}
                aria-label="終演の補足"
                onchange={(evt) => onScreenText('endedNote', evt)}
              ></wa-input>
            </div>
          {/if}
        </section>
      {/if}

      <!-- 任意画像 (オーナーのみ) -->
      {#if canEditModeration}
      <section class="panel">
        <div class="control-row">
          <span class="control-label">
            画像を表示する
            <span class="control-note">QR コードや会場案内など。通常モード以外で出ます。</span>
          </span>
          <wa-switch bind:this={showImageSwitchEl} onchange={onShowImageToggle}></wa-switch>
        </div>
        <div class="control-row">
          <span class="control-label">
            画像
            <span class="control-note">PNG / JPEG / WebP、2 MB まで。</span>
          </span>
          <div class="screen-image-slot">
            {#if screenImageUrl}
              <img class="screen-image-thumb" src={screenImageUrl} alt="設定中の画像" />
            {/if}
            <input
              class="screen-image-input"
              bind:this={imageInputEl}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="画像を選ぶ"
              onchange={onImagePick}
            />
            {#if screenImageUrl}
              <wa-button size="s" variant="danger" appearance="outlined" onclick={requestRemoveScreenImage}>
                <i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i> 削除
              </wa-button>
            {/if}
          </div>
        </div>
        <div class="control-row">
          <span class="control-label">画像に添える一言</span>
          <wa-input
            size="s"
            class="settings-input"
            value={screen.imageCaption || ''}
            aria-label="画像に添える一言"
            onchange={onImageCaptionChange}
          ></wa-input>
        </div>
        <div class="control-row">
          <span class="control-label">画像の位置</span>
          <wa-select size="s" class="moderation-select" value={screen.imagePosition || 'bottom-right'} aria-label="画像の位置" onchange={onImagePositionChange}>
            {#each Object.keys(IMAGE_POSITION_LABELS) as key (key)}
              <wa-option value={key}>{IMAGE_POSITION_LABELS[key]}</wa-option>
            {/each}
          </wa-select>
        </div>
        <div class="control-row">
          <span class="control-label">画像の大きさ</span>
          <wa-select size="s" class="moderation-select" value={screen.imageSize || 'medium'} aria-label="画像の大きさ" onchange={onImageSizeChange}>
            {#each Object.keys(IMAGE_SIZE_LABELS) as key (key)}
              <wa-option value={key}>{IMAGE_SIZE_LABELS[key]}</wa-option>
            {/each}
          </wa-select>
        </div>
      </section>
      {/if}

      <!-- ヘッダと時計 (オーナーのみ) -->
      {#if canEditModeration}
      <section class="panel">
        <div class="control-row">
          <span class="control-label">
            ヘッダに監視語を表示する
            <span class="control-note">待機画面のハッシュタグはこの設定に関わらず出ます。</span>
          </span>
          <wa-switch bind:this={termsSwitchEl} disabled={!canEditModeration} onchange={onTermsToggle}></wa-switch>
        </div>
        <div class="control-row">
          <span class={'control-label' + (showTerms ? '' : ' is-dimmed')}>
            ヘッダにキーワードも表示する
            <span class="control-note">投稿者に入力を促すものではないため、既定では出しません。</span>
          </span>
          <wa-switch
            bind:this={keywordsSwitchEl}
            disabled={!canEditModeration || !showTerms}
            onchange={onKeywordsToggle}
          ></wa-switch>
        </div>
        <div class="control-row">
          <span class="control-label">
            時計を表示する
            <span class="control-note">ヘッダ右上。</span>
          </span>
          <wa-switch bind:this={clockSwitchEl} disabled={!canEditModeration} onchange={onClockToggle}></wa-switch>
        </div>
        <div class="control-row">
          <span class={'control-label' + (showClock ? '' : ' is-dimmed')}>
            秒を表示する
            <span class="control-note">時分の右下に小さく添えます。出さない場合は「:」が 1 秒ごとに点滅します。</span>
          </span>
          <wa-switch
            bind:this={secondsSwitchEl}
            disabled={!showClock}
            onchange={onSecondsToggle}
          ></wa-switch>
        </div>
      </section>
      {/if}

      <p class="field-note">
        どのモードでも受信と承認は続きます。通常へ戻すと、その間に届いた投稿がそのまま流れます。
        {#if !canEditModeration}文言・画像・ヘッダの設定はオーナーが行います。ここでは進行に合わせた切り替えだけできます。{/if}
      </p>

    {:else if section === 'manage'}
      <header class="wall-section-head">
        <h2>ウォール管理</h2>
        <p>このウォールそのものの設定。取り消せない操作は下にまとめています。</p>
      </header>

      <section class="panel">
        <div class="control-row">
          <span class="control-label"><i class="fa-solid fa-pen fa-fw" aria-hidden="true"></i> 名前</span>
          <div class="wall-rename-slot">
            {#if renaming}
              <form class="wall-rename-form" onsubmit={onRenameSubmit}>
                <wa-input bind:this={renameInputEl} size="s" aria-label="ウォール名" use:enterKey={submitRename}></wa-input>
                <wa-button type="submit" size="s" variant="brand">
                  <i class="fa-solid fa-check fa-fw" aria-hidden="true"></i>
                </wa-button>
                <wa-button type="button" size="s" appearance="plain" variant="neutral" onclick={cancelRename}>
                  <i class="fa-solid fa-xmark fa-fw" aria-hidden="true"></i>
                </wa-button>
              </form>
            {:else}
              <span>{wall.name}</span>
              {#if wall.isDefault}
                <span class="wall-default-badge">既定</span>
              {/if}
              <wa-button size="s" appearance="outlined" variant="neutral" onclick={startRename}>
                <i class="fa-solid fa-pen fa-fw" aria-hidden="true"></i> 改名
              </wa-button>
            {/if}
          </div>
        </div>

        <div class="control-row">
          <span class="control-label"><i class="fa-solid fa-hashtag fa-fw" aria-hidden="true"></i> ウォール ID</span>
          <span class="wall-manage-id">{wall.id}</span>
        </div>

        <div class="control-row">
          <span class="control-label">
            <i class="fa-solid fa-up-right-from-square fa-fw" aria-hidden="true"></i> 会場モニター
            <span class="control-note wall-manage-id">{wallUrl(wall.id)}</span>
          </span>
          <a class="btn btn-neutral btn-small" href={wallUrl(wall.id)} target="_blank" rel="noopener">
            <i class="fa-solid fa-up-right-from-square fa-fw" aria-hidden="true"></i> 開く
          </a>
        </div>
      </section>

      <section class="panel danger-zone">
        <p class="danger-zone-title"><i class="fa-solid fa-triangle-exclamation fa-fw" aria-hidden="true"></i> 取り消せない操作</p>
        <div class="control-row">
          <span class="control-label">
            表示中の投稿を全消去
            <span class="control-note">会場モニターからも消えます。</span>
          </span>
          <InlineConfirmButton label="全消去" icon="fa-solid fa-broom" className="btn btn-danger btn-small" onConfirm={clearAll} />
        </div>
        {#if !wall.isDefault}
          <div class="control-row">
            <span class="control-label">
              このウォールを削除
              <span class="control-note">監視語・承認設定ごと消えます。</span>
            </span>
            <wa-button size="s" variant="danger" onclick={() => requestDeleteWall(wall)}>
              <i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i> 削除
            </wa-button>
          </div>
        {:else}
          <div class="control-row">
            <span class="control-label">
              このウォールを削除
              <span class="control-note">既定ウォールは削除できません。</span>
            </span>
            <wa-button size="s" variant="danger" disabled>
              <i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i> 削除
            </wa-button>
          </div>
        {/if}
      </section>
    {:else if section === 'ops'}
      <header class="wall-section-head">
        <h2>
          承認待ちと直近の投稿
          <span class="scope-tag scope-tag-wall"><i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> ウォール単位</span>
        </h2>
        <p>設定ではなく、いま流れているものを見る画面です。</p>
      </header>

      <section class="panel">
        <h2 class="panel-title">
          <i class="fa-solid fa-circle-check fa-fw" aria-hidden="true"></i> 承認待ち
          <span class="panel-count">{pendingCount}</span>
        </h2>
        <p class="panel-subtitle">承認するまで会場モニターには出ません。却下した投稿は「非表示にした投稿」から復元できます (除外キーワードに当たったものを除く)。</p>
        <PostList
          posts={store.pending || []}
          emptyMessage="承認待ちの投稿はありません。"
          showApprove={true}
          showHide={true}
          showBlock={true}
          rejectLabel={true}
        />
      </section>

      <section class="panel">
        <h2 class="panel-title">
          <i class="fa-solid fa-comments fa-fw" aria-hidden="true"></i> 直近の投稿
          <span class="panel-count">{recentCount}</span>
        </h2>
        <p class="panel-subtitle">会場モニターに出ている投稿。ここから個別に取り下げられます。</p>
        <PostList posts={store.recent || []} emptyMessage="まだ投稿がありません。" showHide={true} showBlock={true} />
      </section>
    {:else}
      <!-- ここに来るのはナビと本体でセクション id がずれたとき。空白で気付けないのを防ぐ。 -->
      <p class="empty-msg">セクション「{section}」は見つかりませんでした。</p>
    {/if}
</div>
