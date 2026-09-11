<script>
  /**
   * 全ウォール共通ブロック (タブの外側)。
   * 状態 / 配信 ON-OFF / 受信設定 (Jetstream・取り込み) /
   * モデレーションリスト / 非表示にした投稿 / ブロック中の投稿者 / セッション。
   */
  import {
    store,
    togglePause,
    switchJetstream,
    runBackfill,
    loadAvailableModlists,
    subscribeModlist,
    unsubscribeModlist,
    unblockActor,
    revokeAllSessions,
    updateTenantSettings,
    showToast,
    sessionExpiryLabel,
    wallNameOf,
  } from '../lib/store.svelte.js';
  import { enterKey } from '../lib/ime.js';
  import PostList from './PostList.svelte';
  import InlineConfirmButton from './InlineConfirmButton.svelte';
  import MembersPanel from './MembersPanel.svelte';

  // メンバー管理は multi モードの owner / システム管理者にのみ見せる。
  // moderator や single モードでは概念自体が無いため出さない。
  const canManageMembers = $derived(
    store.mode === 'multi' && (store.myRole === 'owner' || store.myRole === 'system')
  );

  const jetstream = $derived(store.state.jetstream || {});
  const stats = $derived(store.state.stats || {});

  let pauseSwitchEl = $state(null);
  $effect(() => {
    if (pauseSwitchEl) {
      const on = !store.state.paused;
      pauseSwitchEl.checked = on;
      pauseSwitchEl.classList.toggle('is-on', on);
    }
  });

  function onPauseChange() {
    togglePause(!(pauseSwitchEl && pauseSwitchEl.checked));
  }

  // 会場モニターのタイトルに出す Bluesky ロゴ。テナント共通の設定。
  const canEditSettings = $derived(store.myRole === 'owner' || store.myRole === 'system');
  const showBlueskyLogo = $derived(store.state.showBlueskyLogo !== false);

  let logoSwitchEl = $state(null);
  $effect(() => {
    if (logoSwitchEl) logoSwitchEl.checked = showBlueskyLogo;
  });

  function onLogoToggle() {
    updateTenantSettings({ showBlueskyLogo: !!(logoSwitchEl && logoSwitchEl.checked) });
  }

  // タイトルのグラデーションを動かすか。
  const animateTitle = $derived(store.settings.animateTitleGradient === true);
  let animateSwitchEl = $state(null);
  $effect(() => {
    if (animateSwitchEl) animateSwitchEl.checked = animateTitle;
  });

  function onAnimateToggle() {
    updateTenantSettings({ animateTitleGradient: !!(animateSwitchEl && animateSwitchEl.checked) });
  }

  let jetstreamSelectEl = $state(null);
  $effect(() => {
    const current = jetstream.host || '';
    if (jetstreamSelectEl && current && document.activeElement !== jetstreamSelectEl) {
      jetstreamSelectEl.value = current;
    }
  });

  function onJetstreamSwitch() {
    const host = jetstreamSelectEl && jetstreamSelectEl.value;
    switchJetstream(host);
  }

  let backfillMinutesEl = $state(null);
  let backfillTargetEl = $state(null);

  function onBackfillRun() {
    const minutes = parseInt((backfillMinutesEl && backfillMinutesEl.value) || '0', 10);
    // 取り込み対象はウォールを名指しで選ぶ。テナント全体の画面には
    // 「選択中のウォール」という文脈が無いため。
    const wallId = (backfillTargetEl && backfillTargetEl.value) || '';
    runBackfill(minutes, wallId);
  }

  // 経過時間は 1 秒ごとに自前で進める。状態のポーリング (3 秒) だけに任せると
  // 表示が飛び飛びになり、進んでいるのか止まっているのか分からないため。
  let nowTick = $state(Date.now());
  $effect(() => {
    if (!(store.backfill && store.backfill.running)) return;
    const timer = setInterval(() => {
      nowTick = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const backfillView = $derived.by(() => {
    const status = store.backfill;
    if (!status) return null;
    const target = status.targetWallId
      ? 'ウォール「' + wallNameOf(status.targetWallId) + '」'
      : '全ウォール';
    if (status.running) {
      const elapsed = status.startedAt ? Math.max(0, Math.round((nowTick - status.startedAt) / 1000)) : 0;
      return {
        variant: 'brand',
        icon: 'fa-solid fa-spinner fa-spin',
        text: '取り込み中: 過去 ' + status.minutes + ' 分 / ' + target,
        note:
          '収集済み ' +
          (status.buffered || 0) +
          ' 件 / ' +
          elapsed +
          ' 秒経過 — 取り込みはサーバー側で動いています。この画面を閉じても止まりません。',
      };
    }
    if (!status.finishedAt) return null;
    const took = status.startedAt ? ((status.finishedAt - status.startedAt) / 1000).toFixed(1) : '-';
    return {
      variant: status.caughtUp ? 'success' : 'warning',
      icon: status.caughtUp ? 'fa-solid fa-circle-check' : 'fa-solid fa-triangle-exclamation',
      text: '直近の取り込み: 過去 ' + status.minutes + ' 分 / ' + status.added + ' 件を追加',
      note:
        target +
        ' / ' +
        took +
        ' 秒' +
        (status.caughtUp ? '' : ' — 現在に追いつく前に打ち切られました'),
    };
  });

  let modlistActorInputEl = $state(null);
  let availableLists = $state(null);
  let loadingLists = $state(false);

  async function onLoadLists() {
    loadingLists = true;
    const actor = ((modlistActorInputEl && modlistActorInputEl.value) || '').trim();
    availableLists = await loadAvailableModlists(actor);
    loadingLists = false;
  }

  function buildListKindLabel(purpose) {
    const isMod = String(purpose || '').indexOf('modlist') >= 0;
    return {
      isMod,
      icon: isMod ? 'fa-solid fa-shield-halved' : 'fa-solid fa-bookmark',
      label: isMod ? 'モデレーション' : '通常リスト',
      title: isMod
        ? 'モデレーションリスト: 掲載アカウントを非表示にする用途のリスト'
        : '通常リスト (キュレーションリスト): 本来は購読して見るためのリスト',
    };
  }

  async function onSubscribe(uri) {
    const ok = await subscribeModlist(uri);
    if (ok) availableLists = null;
  }

  let { section = 'status' } = $props();

  // ---- イベント情報 ----
  let titleInputEl = $state(null);
  let subtitleInputEl = $state(null);
  let titleDraft = $state('');
  let subtitleDraft = $state('');
  let eventLoaded = false;

  // ポーリングで入力中の値が戻らないよう、サーバー値を写すのは初回だけ。
  // ただし入力欄はセクションを切り替えるたびに作り直されるので、
  // 要素が生えた時点で下書きを書き戻す (入力中の欄には触らない)。
  $effect(() => {
    const t = store.settings.title;
    const sub = store.settings.subtitle;
    if (!eventLoaded && (t || sub)) {
      eventLoaded = true;
      titleDraft = t || '';
      subtitleDraft = sub || '';
    }
    restoreInput(titleInputEl, titleDraft);
    restoreInput(subtitleInputEl, subtitleDraft);
  });

  function restoreInput(el, value) {
    if (!el) return;
    if (el.matches(':focus-within')) return;
    if (el.value === value) return;
    el.value = value;
  }

  function onEventInput() {
    titleDraft = (titleInputEl && titleInputEl.value) || '';
    subtitleDraft = (subtitleInputEl && subtitleInputEl.value) || '';
  }

  function saveEventInfo() {
    updateTenantSettings({ title: titleDraft.trim(), subtitle: subtitleDraft.trim() });
  }

  // ---- 取り込みの候補 ----
  let presetInputEl = $state(null);
  const presets = $derived(store.settings.backfillPresets || []);

  function presetLabel(minutes) {
    if (minutes % 1440 === 0) return minutes / 1440 + ' 日';
    if (minutes % 60 === 0) return minutes / 60 + ' 時間';
    return minutes + ' 分';
  }

  function addPreset() {
    const raw = ((presetInputEl && presetInputEl.value) || '').trim();
    const minutes = parseInt(raw, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 2160) {
      showToast('1 〜 2160 分で指定してください');
      return false;
    }
    if (presets.includes(minutes)) {
      showToast('すでに登録されています');
      return false;
    }
    updateTenantSettings({ backfillPresets: presets.concat([minutes]) });
    if (presetInputEl) presetInputEl.value = '';
    return true;
  }

  function removePreset(minutes) {
    updateTenantSettings({ backfillPresets: presets.filter((m) => m !== minutes) });
  }

  // ---- NG ワード / 正規表現 ----
  let ngInputEl = $state(null);
  const ngWords = $derived(store.settings.ngWords || []);
  const ngPatterns = $derived(store.settings.ngPatterns || []);

  function ngValue() {
    return ((ngInputEl && ngInputEl.value) || '').trim();
  }

  function addNgWord() {
    const value = ngValue();
    if (!value) return false;
    if (ngWords.includes(value.toLowerCase())) {
      showToast('すでに登録されています');
      return false;
    }
    updateTenantSettings({ ngWords: ngWords.concat([value]) });
    if (ngInputEl) ngInputEl.value = '';
    return true;
  }

  function addNgPattern() {
    const value = ngValue();
    if (!value) return false;
    if (ngPatterns.includes(value)) {
      showToast('すでに登録されています');
      return false;
    }
    updateTenantSettings({ ngPatterns: ngPatterns.concat([value]) });
    if (ngInputEl) ngInputEl.value = '';
    return true;
  }

  function removeNgWord(word) {
    updateTenantSettings({ ngWords: ngWords.filter((w) => w !== word) });
  }

  function removeNgPattern(pattern) {
    updateTenantSettings({ ngPatterns: ngPatterns.filter((p) => p !== pattern) });
  }

  // ---- リプライ / ラベル ----
  let repliesSwitchEl = $state(null);
  let labeledSwitchEl = $state(null);
  $effect(() => {
    if (repliesSwitchEl) repliesSwitchEl.checked = store.settings.allowReplies !== false;
  });
  $effect(() => {
    if (labeledSwitchEl) labeledSwitchEl.checked = store.settings.filterLabeled !== false;
  });

  function onRepliesToggle() {
    updateTenantSettings({ allowReplies: !!(repliesSwitchEl && repliesSwitchEl.checked) });
  }

  function onLabeledToggle() {
    updateTenantSettings({ filterLabeled: !!(labeledSwitchEl && labeledSwitchEl.checked) });
  }
</script>

{#if section === 'status'}
<header class="wall-section-head">
  <h2>状態
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>
  <p>いまの受信状況と、選択中のウォールの集計。</p>
</header>
<!-- 状態 (ウォールの作業領域のナビからここへ戻れるよう id を振る) -->
<section id="shared-panels" class="panel panel-full">
  <h2 class="panel-title">
    <i class="fa-solid fa-gauge-high fa-fw" aria-hidden="true"></i> 状態
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>
  <div class="status-grid">
    <div class="status-item">
      <span class="status-label">Jetstream</span>
      <wa-badge variant={jetstream.connected ? 'success' : 'danger'}>{jetstream.connected ? '接続中' : '切断'}</wa-badge>
    </div>
    <div class="status-item">
      <span class="status-label">接続先ホスト</span>
      <span class="status-value">{jetstream.host || '-'}</span>
    </div>
    <div class="status-item">
      <span class="status-label">再接続回数</span>
      <span class="status-value">{jetstream.reconnects != null ? jetstream.reconnects : '-'}</span>
    </div>
    <div class="status-item">
      <span class="status-label">モデレーションモード</span>
      <span class="status-value">{store.state.moderationMode === 'approve' ? '承認モード' : '公開モード'}</span>
    </div>
    <div class="status-item">
      <span class="status-label">稼働時間</span>
      <span class="status-value">{store.uptimeText}</span>
    </div>
  </div>
  <p class="panel-subtitle">
    <i class="fa-solid fa-desktop fa-fw" aria-hidden="true"></i> 以下の集計は選択中のウォール「{store.state.wallName || '-'}」のものです。
  </p>
  <div class="stats-grid">
    <div class="stat-box">
      <span class="stat-num">{stats.matched != null ? stats.matched : 0}</span>
      <span class="stat-label">一致件数</span>
    </div>
    <div class="stat-box">
      <span class="stat-num">{stats.displayed != null ? stats.displayed : 0}</span>
      <span class="stat-label">表示件数</span>
    </div>
    <div class="stat-box">
      <span class="stat-num">{stats.rejected != null ? stats.rejected : 0}</span>
      <span class="stat-label">除外件数</span>
    </div>
    <div class="stat-box">
      <span class="stat-num">{stats.authors != null ? stats.authors : 0}</span>
      <span class="stat-label">投稿者数</span>
    </div>
  </div>
</section>



{#if store.mode !== 'multi'}
  <!-- マルチテナント運用では Jetstream 接続はテナント横断の共有資源であり、
       テナント側からの切り替えはサーバー側で 403 になる (システム管理画面に集約)。
       そのため UI 自体をここでは出さない。 -->
  <section class="panel">
    <div class="field">
      <label for="jetstream-select"><i class="fa-solid fa-network-wired fa-fw" aria-hidden="true"></i> Jetstream 接続先</label>
      <div class="field-row">
        <wa-select id="jetstream-select" bind:this={jetstreamSelectEl} disabled={!canEditSettings}>
          {#each store.jetstreamHosts || [] as host (host)}
            <wa-option value={host}>{host}</wa-option>
          {/each}
        </wa-select>
        <wa-button variant="neutral" appearance="outlined" disabled={!canEditSettings} onclick={onJetstreamSwitch}>
          <i class="fa-solid fa-arrows-rotate fa-fw" aria-hidden="true"></i> 切り替え
        </wa-button>
      </div>
      <p class="field-note">
        投稿の受信元です。すべてのウォールが 1 本の接続を共有しているため、切り替えると全画面に影響します。
        切り替え中の取りこぼしは、直近のカーソルから再生して補填されます。
      </p>
    </div>
  </section>
{/if}

{:else if section === 'event'}
<header class="wall-section-head">
  <h2>イベント情報
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>
  <p>会場モニターのヘッダと待機画面に出る文言。</p>
</header>

<div class="monitor-preview">
  <div class="monitor-preview-bar">
    <div class="monitor-preview-title">
      {#if store.settings.showBlueskyLogo !== false}
        <svg class="monitor-preview-logo" viewBox="0 0 576 512" aria-hidden="true">
          <path fill="#0085ff" d="M407.8 294.7c-3.3-.4-6.7-.8-10-1.3 3.4 .4 6.7 .9 10 1.3zM288 227.1C261.9 176.4 190.9 81.9 124.9 35.3 61.6-9.4 37.5-1.7 21.6 5.5 3.3 13.8 0 41.9 0 58.4S9.1 194 15 213.9c19.5 65.7 89.1 87.9 153.2 80.7 3.3-.5 6.6-.9 10-1.4-3.3 .5-6.6 1-10 1.4-93.9 14-177.3 48.2-67.9 169.9 120.3 124.6 164.8-26.7 187.7-103.4 22.9 76.7 49.2 222.5 185.6 103.4 102.4-103.4 28.1-156-65.8-169.9-3.3-.4-6.7-.8-10-1.3 3.4 .4 6.7 .9 10 1.3 64.1 7.1 133.6-15.1 153.2-80.7 5.9-19.9 15-138.9 15-155.5s-3.3-44.7-21.6-52.9c-15.8-7.1-40-14.9-103.2 29.8-66.1 46.6-137.1 141.1-163.2 191.8z"></path>
        </svg>
      {/if}
      <span class={animateTitle ? 'monitor-preview-title-animated' : ''}>{titleDraft || 'Live Wall'}</span>
    </div>
    <div class="monitor-preview-sub">{subtitleDraft}</div>
    <div class="monitor-preview-placeholder">
      <span>監視語</span>
      <span>時計</span>
    </div>
  </div>
  <p class="monitor-preview-caption">会場モニターのヘッダ (プレビュー)。監視語と時計はウォールごとの設定です。</p>
</div>

<section class="panel">
  <div class="control-row">
    <span class="control-label">
      イベント名
      <span class="control-note">モニターのタイトル。</span>
    </span>
    <wa-input
      bind:this={titleInputEl}
      size="s"
      class="settings-input"
      aria-label="イベント名"
      disabled={!canEditSettings}
      oninput={onEventInput}
      onchange={saveEventInfo}
    ></wa-input>
  </div>
  <div class="control-row">
    <span class="control-label">
      サブテキスト
      <span class="control-note">会場名や日付など。</span>
    </span>
    <wa-input
      bind:this={subtitleInputEl}
      size="s"
      class="settings-input"
      aria-label="サブテキスト"
      disabled={!canEditSettings}
      oninput={onEventInput}
      onchange={saveEventInfo}
    ></wa-input>
  </div>
  <div class="control-row">
    <span class="control-label">
      ウォールタイトルに Bluesky ロゴを表示する
      <span class="control-note">Bluesky のロゴを表示します。設定をオフにすると Bluesky のロゴのみ非表示になります。</span>
    </span>
    <wa-switch bind:this={logoSwitchEl} disabled={!canEditSettings} onchange={onLogoToggle}></wa-switch>
  </div>
  <div class="control-row">
    <span class="control-label">
      タイトルのグラデーションを動かす
      <span class="control-note">
        会場モニターのタイトルの色をゆっくり流します。動きを減らす設定の端末では自動的に止まります。
      </span>
    </span>
    <wa-switch bind:this={animateSwitchEl} disabled={!canEditSettings} onchange={onAnimateToggle}></wa-switch>
  </div>
</section>
{#if !canEditSettings}
  <p class="field-note">この設定を変更できるのはオーナーだけです。</p>
{/if}

{:else if section === 'delivery'}
<header class="wall-section-head">
  <h2>モニターへの配信
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>
  <p>会場モニターへ出すかどうか。受信そのものは止まりません。</p>
</header>
<!-- 配信 ON/OFF -->
<section class="panel">
  <div class="control-row">
    <span class="control-label">
      配信の有効 / 停止
      <span class="control-note">投稿の受信は止まりません。会場モニターへの表示だけを止めます。</span>
    </span>
    <div class="switch-row">
      <wa-switch class="pause-toggle" bind:this={pauseSwitchEl} onchange={onPauseChange}></wa-switch>
      <span class="toggle-text">{store.state.paused ? '停止中' : '有効'}</span>
    </div>
  </div>
</section>


{:else if section === 'ingest'}
<header class="wall-section-head">
  <h2>バックフィル
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>
  <p>過去に遡って投稿を取り込みます。ライブ受信と並行して動くため、実行中も新着の表示は止まりません。取り込みはサーバー側で動くので、この画面を閉じても中断されません。</p>
</header>

<section class="panel">
  <div class="field">
    <label for="backfill-minutes"><i class="fa-solid fa-clock-rotate-left fa-fw" aria-hidden="true"></i> 取り込む</label>
    <div class="field-row">
      <wa-select id="backfill-minutes" bind:this={backfillMinutesEl} label="遡る時間" value={String(presets[0] || 120)}>
        {#each presets as minutes (minutes)}
          <wa-option value={String(minutes)}>過去 {presetLabel(minutes)}</wa-option>
        {/each}
      </wa-select>
      <wa-select id="backfill-target" bind:this={backfillTargetEl} label="取り込み先" value="">
        <wa-option value="">すべてのウォール</wa-option>
        {#each store.walls as w (w.id)}
          <wa-option value={w.id}>{w.name}</wa-option>
        {/each}
      </wa-select>
      <wa-button
        variant="neutral"
        appearance="outlined"
        disabled={!canEditSettings || (store.backfill && store.backfill.running)}
        onclick={onBackfillRun}
      >
        <i class="fa-solid fa-download fa-fw" aria-hidden="true"></i> 取り込む
      </wa-button>
    </div>
    <p class="field-note">
      それぞれのウォールの監視語に一致した投稿だけを拾います。既に削除された投稿は取り込まれません。
      上限は約 36 時間 (2160 分) です。
    </p>
    {#if backfillView}
      <wa-callout variant={backfillView.variant}>
        <i class={backfillView.icon + ' fa-fw'} slot="icon" aria-hidden="true"></i>
        <span aria-live="polite">{backfillView.text}</span>
        <br />
        <small>{backfillView.note}</small>
      </wa-callout>
    {/if}
  </div>
</section>

<section class="panel">
  <div class="field">
    <label for="backfill-preset-input"><i class="fa-solid fa-list-ol fa-fw" aria-hidden="true"></i> 遡る時間の候補</label>
    <div class="field-row">
      <wa-input
        id="backfill-preset-input"
        bind:this={presetInputEl}
        size="s"
        type="number"
        min="1"
        max="2160"
        placeholder="分で指定 (例: 360)"
        disabled={!canEditSettings}
        use:enterKey={addPreset}
      ></wa-input>
      <wa-button size="s" variant="brand" disabled={!canEditSettings} onclick={addPreset}>
        <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> 候補を追加
      </wa-button>
    </div>
    <ul class="term-list">
      {#each presets as minutes (minutes)}
        <li class="term-item">
          <wa-tag with-remove variant="neutral" aria-label={presetLabel(minutes) + ' を候補から外す'} onwa-remove={() => removePreset(minutes)}>
            {presetLabel(minutes)}
          </wa-tag>
        </li>
      {/each}
    </ul>
    {#if presets.length === 0}
      <p class="empty-msg">候補がありません。</p>
    {/if}
    <p class="field-note">ここで足した候補が、上の「遡る時間」とウォール作成時のメニューに出ます。</p>
  </div>
</section>

{:else if section === 'moderation'}
<header class="wall-section-head">
  <h2>モデレーション
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>
  <p>全ウォールに効く除外。ウォールごとの承認設定とは別です。</p>
</header>

<section class="panel">
  <h2 class="panel-title">
    <i class="fa-solid fa-ban fa-fw" aria-hidden="true"></i> NG ワード / 正規表現
    <span class="panel-count">{ngWords.length + ngPatterns.length}</span>
  </h2>
  <div class="field-row">
    <wa-input
      bind:this={ngInputEl}
      size="s"
      autocomplete="off"
      placeholder="語、または正規表現"
      aria-label="NG ワードまたは正規表現"
      disabled={!canEditSettings}
      use:enterKey={addNgWord}
    ></wa-input>
    <wa-button size="s" variant="danger" disabled={!canEditSettings} onclick={addNgWord}>
      <i class="fa-solid fa-plus fa-fw" aria-hidden="true"></i> 語を追加
    </wa-button>
    <wa-button size="s" variant="warning" appearance="outlined" disabled={!canEditSettings} onclick={addNgPattern}>
      <i class="fa-solid fa-asterisk fa-fw" aria-hidden="true"></i> 正規表現
    </wa-button>
  </div>
  <ul class="term-rows">
    {#each ngWords as word (word)}
      <li class="term-row">
        <span class="term-row-icon term-row-icon-keyword" aria-hidden="true"><i class="fa-solid fa-font"></i></span>
        <span class="term-row-value">{word}</span>
        <span class="term-row-type">語</span>
        <button type="button" class="term-row-remove" aria-label={word + ' を削除'} disabled={!canEditSettings} onclick={() => removeNgWord(word)}>
          <i class="fa-solid fa-xmark fa-fw" aria-hidden="true"></i>
        </button>
      </li>
    {/each}
    {#each ngPatterns as pattern (pattern)}
      <li class="term-row">
        <span class="term-row-icon term-row-icon-hashtag" aria-hidden="true"><i class="fa-solid fa-asterisk"></i></span>
        <span class="term-row-value">{pattern}</span>
        <span class="term-row-type">正規表現</span>
        <button type="button" class="term-row-remove" aria-label={pattern + ' を削除'} disabled={!canEditSettings} onclick={() => removeNgPattern(pattern)}>
          <i class="fa-solid fa-xmark fa-fw" aria-hidden="true"></i>
        </button>
      </li>
    {/each}
  </ul>
  {#if ngWords.length + ngPatterns.length === 0}
    <p class="empty-msg">NG ワードはありません。</p>
  {/if}
  <p class="field-note">一致した投稿は受信した時点で捨てます。ウォールごとの除外キーワードとは別です。</p>
</section>

<section class="panel">
  <div class="control-row">
    <span class="control-label">
      リプライを表示する
      <span class="control-note">オフにすると返信は拾いません。</span>
    </span>
    <wa-switch bind:this={repliesSwitchEl} disabled={!canEditSettings} onchange={onRepliesToggle}></wa-switch>
  </div>
  <div class="control-row">
    <span class="control-label">
      成人向けラベルを除外する
      <span class="control-note">自己申告ラベルの付いた投稿を拾いません。</span>
    </span>
    <wa-switch bind:this={labeledSwitchEl} disabled={!canEditSettings} onchange={onLabeledToggle}></wa-switch>
  </div>
</section>
<!-- モデレーションリスト -->
<section class="panel panel-modlist">
  <h2 class="panel-title">
    <i class="fa-solid fa-shield-halved fa-fw" aria-hidden="true"></i> モデレーションリスト
    <span class="panel-count">{(store.modLists || []).length}</span>
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>
  {#if (store.modLists || []).length > 0}
    <ul class="actor-list">
      {#each store.modLists as info (info.uri)}
        <li class="actor-item actor-item-wrap">
          <div>
            <div class="actor-name">{info.name}</div>
            <div class="field-note list-meta">
              {#if buildListKindLabel(info.purpose).isMod}
                <span class="list-badge list-badge-mod" title={buildListKindLabel(info.purpose).title}>
                  <i class={buildListKindLabel(info.purpose).icon} aria-hidden="true"></i>
                  <span>{buildListKindLabel(info.purpose).label}</span>
                </span>
              {:else}
                <span class="list-badge list-badge-curate" title={buildListKindLabel(info.purpose).title}>
                  <i class={buildListKindLabel(info.purpose).icon} aria-hidden="true"></i>
                  <span>{buildListKindLabel(info.purpose).label}</span>
                </span>
              {/if}
              <span>{info.error ? info.memberCount + ' 件 (最新の取得に失敗: ' + info.error + ')' : info.memberCount + ' 件'}</span>
            </div>
          </div>
          <button type="button" class="btn btn-neutral btn-small" onclick={() => unsubscribeModlist(info.uri)}>
            <i class="fa-solid fa-link-slash fa-fw" aria-hidden="true"></i> 購読解除
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty-msg">購読中のリストはありません。</p>
  {/if}

  <div class="field">
    <label for="modlist-actor-input"><i class="fa-solid fa-user fa-fw" aria-hidden="true"></i> リストを読み込むアカウント</label>
    <div class="field-row">
      <wa-input id="modlist-actor-input" bind:this={modlistActorInputEl} autocomplete="off" placeholder="ログイン中のアカウント (OAuth 時は自動)" use:enterKey={onLoadLists}></wa-input>
      <wa-button variant="neutral" appearance="outlined" disabled={loadingLists} onclick={onLoadLists}>
        <i class="fa-solid fa-cloud-arrow-down fa-fw" aria-hidden="true"></i> リストを取得
      </wa-button>
    </div>
    <p class="field-note">掲載アカウントの投稿は表示されなくなります。リストは 5 分ごとに取り直されます。</p>
  </div>

  {#if availableLists !== null}
    <ul class="actor-list">
      {#if availableLists.length === 0}
        <li class="empty-msg">このアカウントにはリストがありません。</li>
      {:else}
        {#each availableLists as list (list.uri)}
          <li class="actor-item actor-item-wrap">
            <div>
              <div class="actor-name">{list.name}</div>
              <div class="field-note list-meta">
                {#if buildListKindLabel(list.purpose).isMod}
                  <span class="list-badge list-badge-mod" title={buildListKindLabel(list.purpose).title}>
                    <i class={buildListKindLabel(list.purpose).icon} aria-hidden="true"></i>
                    <span>{buildListKindLabel(list.purpose).label}</span>
                  </span>
                {:else}
                  <span class="list-badge list-badge-curate" title={buildListKindLabel(list.purpose).title}>
                    <i class={buildListKindLabel(list.purpose).icon} aria-hidden="true"></i>
                    <span>{buildListKindLabel(list.purpose).label}</span>
                  </span>
                {/if}
                <span>{list.itemCount} 件</span>
              </div>
            </div>
            <button type="button" class="btn btn-primary btn-small" onclick={() => onSubscribe(list.uri)}>
              <i class="fa-solid fa-link fa-fw" aria-hidden="true"></i> 購読
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}
</section>

<!-- ブロック中の投稿者 -->
<section class="panel panel-blocked">
  <h2 class="panel-title">
    <i class="fa-solid fa-ban fa-fw" aria-hidden="true"></i> ブロック中の投稿者
    <span class="panel-count">{(store.blocked || []).length}</span>
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>
  {#if (store.blocked || []).length > 0}
    <ul class="actor-list">
      {#each store.blocked as actor (actor)}
        <li class="actor-item">
          <span class="actor-name">{actor}</span>
          <button type="button" class="btn btn-primary btn-small" onclick={() => unblockActor(actor)}>
            <i class="fa-solid fa-unlock fa-fw" aria-hidden="true"></i> ブロック解除
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty-msg">ブロック中の投稿者はいません。</p>
  {/if}
</section>

<!-- 非表示にした投稿 -->
<section class="panel panel-hidden">
  <h2 class="panel-title">
    <i class="fa-solid fa-eye-slash fa-fw" aria-hidden="true"></i> 非表示にした投稿
    <span class="panel-count">{(store.hidden || []).length}</span>
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>
  <PostList posts={store.hidden || []} emptyMessage="非表示にした投稿はありません。" showUnhide={true} />
</section>


{:else if section === 'access'}
<header class="wall-section-head">
  <h2>メンバーとセッション
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> テナント共通</span>
  </h2>
  <p>このテナントを操作できるアカウントと、ログイン中のセッション。</p>
</header>
{#if canManageMembers}
  <MembersPanel />
{/if}

<!-- セッション -->
<section class="panel">
  <h2 class="panel-title">
    <i class="fa-solid fa-user-lock fa-fw" aria-hidden="true"></i> セッション
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>
  <div class="control-row">
    <span class="control-label">
      ログイン中のセッション <span class="panel-count">{store.sessionCount}</span>
      <span class="control-note">{sessionExpiryLabel()}</span>
    </span>
    <InlineConfirmButton
      label="全セッション失効"
      icon="fa-solid fa-user-lock"
      className="btn btn-danger"
      onConfirm={revokeAllSessions}
    />
  </div>
</section>

{/if}
