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
    const useCurrent = backfillTargetEl && backfillTargetEl.value === 'current';
    runBackfill(minutes, useCurrent);
  }

  const backfillText = $derived.by(() => {
    const status = store.backfill;
    if (!status) return '';
    if (status.running) {
      const elapsed = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
      const target = status.targetWallId ? 'ウォール「' + wallNameOf(status.targetWallId) + '」' : '全ウォール';
      return '取り込み中: 過去 ' + status.minutes + ' 分 / ' + target + ' (' + elapsed + ' 秒経過)';
    }
    if (!status.finishedAt) return '';
    const took = status.startedAt ? ((status.finishedAt - status.startedAt) / 1000).toFixed(1) : '-';
    return (
      '直近の取り込み: 過去 ' +
      status.minutes +
      ' 分 / ' +
      status.added +
      ' 件を追加 (' +
      took +
      ' 秒)' +
      (status.caughtUp ? '' : ' — 途中で打ち切られました')
    );
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
</script>

<!-- 状態 -->
<section class="panel panel-full">
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

<!-- 配信 ON/OFF -->
<section class="panel">
  <h2 class="panel-title">
    <i class="fa-solid fa-tower-broadcast fa-fw" aria-hidden="true"></i> モニターへの配信
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>
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

<!-- 受信設定 -->
<section class="panel">
  <h2 class="panel-title">
    <i class="fa-solid fa-satellite-dish fa-fw" aria-hidden="true"></i> 受信設定
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>

  {#if store.mode !== 'multi'}
    <!-- マルチテナント運用では Jetstream 接続はテナント横断の共有資源であり、
         テナント側からの切り替えはサーバー側で 403 になる (システム管理画面に集約)。
         そのため UI 自体をここでは出さない。 -->
    <div class="field">
      <label for="jetstream-select"><i class="fa-solid fa-network-wired fa-fw" aria-hidden="true"></i> Jetstream 接続先</label>
      <div class="field-row">
        <wa-select id="jetstream-select" bind:this={jetstreamSelectEl}>
          {#each store.jetstreamHosts || [] as host (host)}
            <wa-option value={host}>{host}</wa-option>
          {/each}
        </wa-select>
        <wa-button variant="neutral" appearance="outlined" onclick={onJetstreamSwitch}>
          <i class="fa-solid fa-arrows-rotate fa-fw" aria-hidden="true"></i> 切り替え
        </wa-button>
      </div>
      <p class="field-note">
        投稿の受信元です。すべてのウォールが 1 本の接続を共有しているため、切り替えると全画面に影響します。
        切り替え中の取りこぼしは、直近のカーソルから再生して補填されます。
      </p>
    </div>
  {:else}
    <p class="field-note">
      <i class="fa-solid fa-circle-info fa-fw" aria-hidden="true"></i>
      マルチテナント運用では接続先の切り替えはシステム管理画面から行います。
    </p>
  {/if}

  <div class="field">
    <label for="backfill-minutes"><i class="fa-solid fa-clock-rotate-left fa-fw" aria-hidden="true"></i> 過去の投稿を取り込む</label>
    <div class="field-row">
      <wa-input id="backfill-minutes" bind:this={backfillMinutesEl} type="number" min="1" max="2160" step="10" value="120" label="遡る分数" style="max-width: 10em;"></wa-input>
      <wa-select id="backfill-target" bind:this={backfillTargetEl} label="取り込み対象" value="">
        <wa-option value="">すべてのウォール</wa-option>
        <wa-option value="current">選択中のウォールのみ</wa-option>
      </wa-select>
      <wa-button variant="neutral" appearance="outlined" disabled={store.backfill && store.backfill.running} onclick={onBackfillRun}>
        <i class="fa-solid fa-download fa-fw" aria-hidden="true"></i> 取り込む
      </wa-button>
    </div>
    <p class="field-note">
      指定した分だけ過去に遡って投稿を拾います。ライブ受信と並行して動くため、実行中も新着の表示は止まりません。
      上限は約 36 時間 (2160 分) です。既に削除された投稿は取り込まれません。
    </p>
    {#if backfillText}
      <wa-callout variant="neutral">
        <i class="fa-solid fa-spinner fa-fw" aria-hidden="true"></i>
        <span>{backfillText}</span>
      </wa-callout>
    {/if}
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

<!-- 非表示にした投稿 -->
<section class="panel panel-hidden">
  <h2 class="panel-title">
    <i class="fa-solid fa-eye-slash fa-fw" aria-hidden="true"></i> 非表示にした投稿
    <span class="panel-count">{(store.hidden || []).length}</span>
    <span class="scope-tag scope-tag-shared"><i class="fa-solid fa-globe fa-fw" aria-hidden="true"></i> 全ウォール共通</span>
  </h2>
  <PostList posts={store.hidden || []} emptyMessage="非表示にした投稿はありません。" showUnhide={true} />
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
