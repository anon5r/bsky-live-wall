/**
 * テナントの集合を管理する層。
 *
 * IngestHub (Jetstream 接続) は全テナント共有で 1 個だけ持ち、`start()`/`stop()`
 * はここで 1 回だけ呼ぶ。`WallManager.start()`/`stop()` は冪等ではない
 * `hub.start()`/`hub.stop()` を呼ばない作りになっているため
 * (`src/ingest/wall-manager.ts` 参照)、テナントが何個あっても hub の接続は 1 本に保たれる。
 *
 * single モードでは `.env` から作った 1 テナントだけを持ち、DB を使わない。
 * multi モードでは `TenantStore` (SQLite) を出どころにする。
 */
import { defaultBackfillPresets } from '../shared/config.js';
import type { AppConfig } from '../shared/config.js';
import type { IngestHub, TenantRegistry, TenantRuntime } from '../shared/ingest-contracts.js';
import type { Tenant, TenantSettings, TenantStore } from '../shared/tenancy.js';
import { createLogger } from '../shared/logger.js';
import { createIngestHub } from './ingest-hub.js';
import { createSqliteTenantStore } from '../store/sqlite-store.js';
import { WallManager } from './wall-manager.js';

const log = createLogger('tenant-registry');

/**
 * `.env` (AppConfig.moderation / AppConfig.event) から `TenantSettings` を組み立てる。
 * single モードのテナントは常にこの内容で、`.env` を書き換えない限り変わらない。
 *
 * `ngPatterns` は `TenantSettings` では文字列で持つ (SQLite へそのまま保存できる形に
 * 揃えるため)。`AppConfig.moderation.ngPatterns` はコンパイル済みの RegExp[] なので、
 * `.env` の生の文字列を残した `ngPatternSources` から復元する。
 */
function settingsFromConfig(config: AppConfig): TenantSettings {
  return {
    title: config.event.title,
    subtitle: config.event.subtitle,
    moderationMode: config.moderation.mode,
    keywordRequireApproval: config.moderation.keywordRequireApproval,
    ngWords: [...config.moderation.ngWords],
    ngPatterns: [...config.moderation.ngPatternSources],
    blockActors: [...config.moderation.blockActors],
    allowReplies: config.moderation.allowReplies,
    filterLabeled: config.moderation.filterLabeled,
    allowedLangs: [...config.moderation.allowedLangs],
    startupBackfillMinutes: config.jetstream.startupBackfillMinutes,
    backfillPresets: defaultBackfillPresets(),
    showBlueskyLogo: config.event.showBlueskyLogo,
    animateTitleGradient: config.event.animateTitleGradient,
  };
}

/** single モード運用の唯一のテナントの ownerDid。権限判定を行わないため実質未使用。 */
const SINGLE_TENANT_OWNER_DID = 'single-tenant';

/**
 * single モード。`.env` から作った 1 テナントだけを持ち、DB を使わない。
 * 設定変更はメモリ上のみ (再起動すれば `.env` の内容に戻る)。
 */
export class SingleTenantRegistry implements TenantRegistry {
  readonly hub: IngestHub;
  private readonly runtime: WallManager;

  /**
   * hub を差し替えられるようにしてある。
   * 将来 Jetstream 接続を別プロセス (デーモン) へ出す場合、
   * IngestHub を実装した遠隔版を渡すだけで済み、
   * テナントやウォールの実装には手を入れずに済む。
   */
  constructor(config: AppConfig, hub?: IngestHub) {
    this.hub = hub ?? createIngestHub(config);
    const now = Date.now();
    const tenant: Tenant = {
      id: config.event.id,
      name: config.event.title || config.event.id,
      ownerDid: SINGLE_TENANT_OWNER_DID,
      createdAt: now,
      updatedAt: now,
      settings: settingsFromConfig(config),
    };
    // deps.store を渡さない (= undefined) ことで、WallManager は永続化を一切行わない。
    this.runtime = new WallManager(config, this.hub, tenant);
  }

  async start(): Promise<void> {
    await this.hub.start();
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
    await this.hub.stop();
  }

  getDefault(): TenantRuntime {
    return this.runtime;
  }

  get(tenantId: string): TenantRuntime | undefined {
    return tenantId === this.runtime.tenantId ? this.runtime : undefined;
  }

  list(): TenantRuntime[] {
    return [this.runtime];
  }

  /** single モードでは権限判定を行わないため、常に唯一のテナントを返す。 */
  listForDid(_did: string): TenantRuntime[] {
    return [this.runtime];
  }

  create(): TenantRuntime {
    throw new Error('単一テナント運用ではテナントを作成できません (MULTI_TENANT=true で起動してください)');
  }

  remove(_tenantId: string): boolean {
    throw new Error('単一テナント運用ではテナントを削除できません');
  }
}

/**
 * multi モード。`TenantStore` (SQLite) を出どころとする。
 * テナントは動的に増減するため、起動時に一括で作り、以降は create/remove で追従する。
 */
export class MultiTenantRegistry implements TenantRegistry {
  readonly hub: IngestHub;
  private readonly store: TenantStore;
  private readonly runtimes = new Map<string, WallManager>();

  /** hub の差し替えは SingleTenantRegistry と同じ理由による。 */
  constructor(
    private readonly config: AppConfig,
    hub?: IngestHub
  ) {
    this.hub = hub ?? createIngestHub(config);
    this.store = createSqliteTenantStore(config.tenancy.dataFile);
  }

  async start(): Promise<void> {
    for (const tenant of this.store.listTenants()) {
      this.mount(tenant);
    }
    await this.hub.start();
    for (const runtime of this.runtimes.values()) {
      await runtime.start();
    }
  }

  async stop(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.stop();
    }
    await this.hub.stop();
    this.store.close();
  }

  private mount(tenant: Tenant): WallManager {
    const runtime = new WallManager(this.config, this.hub, tenant, { store: this.store });
    this.runtimes.set(tenant.id, runtime);
    return runtime;
  }

  getDefault(): TenantRuntime {
    // multi では「既定テナント」という概念が無い。呼び出し側 (server 層) が
    // 誤って single 用の経路を使ったときに気付けるよう、0 件なら例外にする。
    const first = this.runtimes.values().next();
    if (first.done) {
      throw new Error(
        'multi モードには既定テナントがありません。テナント ID を指定してアクセスしてください。'
      );
    }
    return first.value;
  }

  get(tenantId: string): TenantRuntime | undefined {
    return this.runtimes.get(tenantId);
  }

  list(): TenantRuntime[] {
    return [...this.runtimes.values()];
  }

  listForDid(did: string): TenantRuntime[] {
    return this.store
      .findTenantsForDid(did)
      .map((t) => this.runtimes.get(t.id))
      .filter((r): r is WallManager => r !== undefined);
  }

  create(input: {
    id: string;
    name: string;
    ownerDid: string;
    ownerHandle: string;
    settings?: Partial<TenantSettings>;
  }): TenantRuntime {
    const tenant = this.store.createTenant(input);
    const runtime = this.mount(tenant);
    // 稼働中に追加された場合、この場で起動する (すでに hub は動いている前提)。
    void runtime.start().catch((err) => log.warn(`テナント起動に失敗しました (${tenant.id})`, err));
    return runtime;
  }

  remove(tenantId: string): boolean {
    const runtime = this.runtimes.get(tenantId);
    if (!runtime) return false;
    void runtime.stop();
    this.runtimes.delete(tenantId);
    return this.store.deleteTenant(tenantId);
  }
}

/** `config.tenancy.mode` に応じて適切な実装を選ぶ。 */
export function createTenantRegistry(config: AppConfig, hub?: IngestHub): TenantRegistry {
  return config.tenancy.mode === 'multi' ? new MultiTenantRegistry(config, hub) : new SingleTenantRegistry(config, hub);
}
