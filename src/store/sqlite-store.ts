/**
 * `TenantStore` の SQLite 実装。
 *
 * Node 24 に組み込みの `node:sqlite` (`DatabaseSync`) を使う。外部依存を増やさない
 * ための制約であり、扱う件数 (テナント数・ウォール数) も小さいので同期 API で十分。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeSlug, RESERVED_SLUGS } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { migrate } from './schema.js';
import { defaultTenantSettings } from './defaults.js';
import type {
  CreateTenantInput,
  PersistedModList,
  PersistedWall,
  Tenant,
  TenantMember,
  TenantSettings,
  TenantStore,
} from '../shared/tenancy.js';

const logger = createLogger('sqlite-store');

/** DB から読み出した行の生の形 (カラム名 = キー)。 */
interface TenantRow {
  id: string;
  name: string;
  owner_did: string;
  created_at: number;
  updated_at: number;
  settings: string;
}

interface MemberRow {
  tenant_id: string;
  did: string;
  handle: string;
  role: string;
  added_at: number;
}

interface WallRow {
  tenant_id: string;
  id: string;
  name: string;
  terms: string;
  display: string;
  is_default: number;
  position: number;
}

interface ModListRow {
  tenant_id: string;
  uri: string;
  added_at: number;
}

/**
 * JSON カラムを安全にパースする。壊れた値が入っていてもプロセスを落とさず、
 * 既定値にフォールバックして警告を出す (運用中の手動編集や将来の互換性事故を想定)。
 */
function parseJsonColumn<T>(raw: string, fallback: T, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn(`${context} の JSON パースに失敗したため既定値を使用します`, err);
    return fallback;
  }
}

function rowToTenant(row: TenantRow): Tenant {
  const settings = parseJsonColumn<TenantSettings>(
    row.settings,
    defaultTenantSettings(),
    `tenants.settings (id=${row.id})`
  );
  return {
    id: row.id,
    name: row.name,
    ownerDid: row.owner_did,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings,
  };
}

function rowToMember(row: MemberRow): TenantMember {
  return {
    tenantId: row.tenant_id,
    did: row.did,
    handle: row.handle,
    role: row.role === 'owner' ? 'owner' : 'moderator',
    addedAt: row.added_at,
  };
}

function rowToWall(row: WallRow): PersistedWall {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    name: row.name,
    terms: parseJsonColumn(row.terms, [], `walls.terms (id=${row.id})`),
    display: parseJsonColumn(
      row.display,
      { maxCards: 40, columns: 1, cardTtlSec: 0, showImages: true },
      `walls.display (id=${row.id})`
    ),
    isDefault: row.is_default !== 0,
    position: row.position,
  };
}

function rowToModList(row: ModListRow): PersistedModList {
  return { tenantId: row.tenant_id, uri: row.uri, addedAt: row.added_at };
}

export class SqliteTenantStore implements TenantStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      const dir = dirname(filePath);
      if (dir !== '' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(filePath);
    // WAL は複数プロセス/読み取りの並行性のため。foreign_keys は CASCADE 削除の前提。
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  // ---------------------------------------------------------------------
  // テナント
  // ---------------------------------------------------------------------

  listTenants(): Tenant[] {
    const rows = this.db.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all() as unknown as TenantRow[];
    return rows.map(rowToTenant);
  }

  getTenant(id: string): Tenant | undefined {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as unknown as
      | TenantRow
      | undefined;
    return row ? rowToTenant(row) : undefined;
  }

  createTenant(input: CreateTenantInput): Tenant {
    const id = normalizeSlug(input.id);
    if (id === '') {
      throw new Error(`テナント ID "${input.id}" は正規化すると空文字になるため使用できません`);
    }
    if (RESERVED_SLUGS.has(id)) {
      throw new Error(`テナント ID "${id}" は予約語のため使用できません`);
    }
    if (this.getTenant(id) !== undefined) {
      throw new Error(`テナント ID "${id}" は既に使用されています`);
    }

    const now = Date.now();
    const settings: TenantSettings = { ...defaultTenantSettings(), ...input.settings };

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO tenants (id, name, owner_did, created_at, updated_at, settings)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.name, input.ownerDid, now, now, JSON.stringify(settings));

      // オーナーを管理不在にしないため、作成と同時に member としても登録する。
      this.db
        .prepare(
          `INSERT INTO tenant_members (tenant_id, did, handle, role, added_at)
           VALUES (?, ?, ?, 'owner', ?)`
        )
        .run(id, input.ownerDid, input.ownerHandle, now);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { id, name: input.name, ownerDid: input.ownerDid, createdAt: now, updatedAt: now, settings };
  }

  updateTenant(
    id: string,
    patch: { name?: string; settings?: Partial<TenantSettings> }
  ): Tenant | undefined {
    const current = this.getTenant(id);
    if (current === undefined) return undefined;

    const name = patch.name ?? current.name;
    const settings: TenantSettings = { ...current.settings, ...patch.settings };
    const updatedAt = Date.now();

    this.db
      .prepare('UPDATE tenants SET name = ?, settings = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(settings), updatedAt, id);

    return { ...current, name, settings, updatedAt };
  }

  deleteTenant(id: string): boolean {
    // members / walls / modlists は ON DELETE CASCADE (foreign_keys = ON 前提) で消える。
    const result = this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------
  // メンバー
  // ---------------------------------------------------------------------

  listMembers(tenantId: string): TenantMember[] {
    const rows = this.db
      .prepare('SELECT * FROM tenant_members WHERE tenant_id = ? ORDER BY added_at ASC')
      .all(tenantId) as unknown as MemberRow[];
    return rows.map(rowToMember);
  }

  addMember(member: Omit<TenantMember, 'addedAt'>): TenantMember {
    const addedAt = Date.now();
    // (tenant_id, did) が既にあれば role / handle を更新する upsert。
    this.db
      .prepare(
        `INSERT INTO tenant_members (tenant_id, did, handle, role, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, did) DO UPDATE SET handle = excluded.handle, role = excluded.role`
      )
      .run(member.tenantId, member.did, member.handle, member.role, addedAt);

    const row = this.db
      .prepare('SELECT * FROM tenant_members WHERE tenant_id = ? AND did = ?')
      .get(member.tenantId, member.did) as unknown as MemberRow;
    return rowToMember(row);
  }

  removeMember(tenantId: string, did: string): boolean {
    const target = this.db
      .prepare('SELECT * FROM tenant_members WHERE tenant_id = ? AND did = ?')
      .get(tenantId, did) as unknown as MemberRow | undefined;
    if (target === undefined) return false;

    if (target.role === 'owner') {
      const ownerCount = this.db
        .prepare("SELECT COUNT(*) AS c FROM tenant_members WHERE tenant_id = ? AND role = 'owner'")
        .get(tenantId) as unknown as { c: number };
      // 最後の 1 人のオーナーは削除させない。管理不在のテナントを作らないため。
      if (ownerCount.c <= 1) return false;
    }

    const result = this.db
      .prepare('DELETE FROM tenant_members WHERE tenant_id = ? AND did = ?')
      .run(tenantId, did);
    return result.changes > 0;
  }

  findTenantsForDid(did: string): Tenant[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tenants t
         JOIN tenant_members m ON m.tenant_id = t.id
         WHERE m.did = ?
         ORDER BY t.created_at ASC`
      )
      .all(did) as unknown as TenantRow[];
    return rows.map(rowToTenant);
  }

  getMemberRole(tenantId: string, did: string): TenantMember['role'] | undefined {
    const row = this.db
      .prepare('SELECT role FROM tenant_members WHERE tenant_id = ? AND did = ?')
      .get(tenantId, did) as unknown as { role: string } | undefined;
    if (row === undefined) return undefined;
    return row.role === 'owner' ? 'owner' : 'moderator';
  }

  // ---------------------------------------------------------------------
  // ウォール
  // ---------------------------------------------------------------------

  listWalls(tenantId: string): PersistedWall[] {
    const rows = this.db
      .prepare('SELECT * FROM walls WHERE tenant_id = ? ORDER BY position ASC, id ASC')
      .all(tenantId) as unknown as WallRow[];
    return rows.map(rowToWall);
  }

  upsertWall(wall: PersistedWall): PersistedWall {
    this.db.exec('BEGIN');
    try {
      if (wall.isDefault) {
        // 同一テナント内で is_default が複数立たないよう、先に他を落としておく。
        this.db
          .prepare('UPDATE walls SET is_default = 0 WHERE tenant_id = ? AND id != ?')
          .run(wall.tenantId, wall.id);
      }

      this.db
        .prepare(
          `INSERT INTO walls (tenant_id, id, name, terms, display, is_default, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, id) DO UPDATE SET
             name = excluded.name,
             terms = excluded.terms,
             display = excluded.display,
             is_default = excluded.is_default,
             position = excluded.position`
        )
        .run(
          wall.tenantId,
          wall.id,
          wall.name,
          JSON.stringify(wall.terms),
          JSON.stringify(wall.display),
          wall.isDefault ? 1 : 0,
          wall.position
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { ...wall };
  }

  deleteWall(tenantId: string, wallId: string): boolean {
    const row = this.db
      .prepare('SELECT is_default FROM walls WHERE tenant_id = ? AND id = ?')
      .get(tenantId, wallId) as unknown as { is_default: number } | undefined;
    if (row === undefined) return false;
    // 既定ウォールは常に存在させておく必要がある (会場モニターの初期表示先)。
    if (row.is_default !== 0) return false;

    const result = this.db
      .prepare('DELETE FROM walls WHERE tenant_id = ? AND id = ?')
      .run(tenantId, wallId);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------
  // モデレーションリスト
  // ---------------------------------------------------------------------

  listModLists(tenantId: string): PersistedModList[] {
    const rows = this.db
      .prepare('SELECT * FROM modlists WHERE tenant_id = ? ORDER BY added_at ASC')
      .all(tenantId) as unknown as ModListRow[];
    return rows.map(rowToModList);
  }

  addModList(tenantId: string, uri: string): PersistedModList {
    const addedAt = Date.now();
    // 同じ URI の二重登録は無視する (INSERT OR IGNORE)。既存の addedAt を保つ。
    this.db
      .prepare(
        'INSERT OR IGNORE INTO modlists (tenant_id, uri, added_at) VALUES (?, ?, ?)'
      )
      .run(tenantId, uri, addedAt);

    const row = this.db
      .prepare('SELECT * FROM modlists WHERE tenant_id = ? AND uri = ?')
      .get(tenantId, uri) as unknown as ModListRow;
    return rowToModList(row);
  }

  removeModList(tenantId: string, uri: string): boolean {
    const result = this.db
      .prepare('DELETE FROM modlists WHERE tenant_id = ? AND uri = ?')
      .run(tenantId, uri);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteTenantStore(filePath: string): TenantStore {
  return new SqliteTenantStore(filePath);
}
