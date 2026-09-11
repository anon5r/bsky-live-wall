/**
 * SQLite スキーマ定義とマイグレーション。
 *
 * `PRAGMA user_version` でスキーマバージョンを管理する。起動時に現在のバージョンから
 * 最新までの差分だけを適用する。今回は version 1 のみだが、将来カラムを足す場合は
 * `MIGRATIONS` に version 2 以降を追記していけばよい。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 各バージョンで実行する DDL。配列のインデックス + 1 が到達後のバージョンになる。 */
const MIGRATIONS: string[] = [
  // version 1: 初期スキーマ
  `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_did TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settings TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    did TEXT NOT NULL,
    handle TEXT NOT NULL,
    role TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, did)
  );

  CREATE INDEX IF NOT EXISTS idx_tenant_members_did ON tenant_members(did);

  CREATE TABLE IF NOT EXISTS walls (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    terms TEXT NOT NULL,
    display TEXT NOT NULL,
    is_default INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );

  CREATE TABLE IF NOT EXISTS modlists (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    uri TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, uri)
  );
  `,
  // version 2: ウォール単位の承認設定。既存行は 'inherit' (テナント設定に従う) で始まる。
  `
  ALTER TABLE walls ADD COLUMN moderation_mode TEXT NOT NULL DEFAULT 'inherit';
  ALTER TABLE walls ADD COLUMN keyword_require_approval TEXT NOT NULL DEFAULT 'inherit';
  `,
  // version 3: ウォール単位の除外キーワード。既存行は「除外なし・自動で非承認」で始まる。
  `
  ALTER TABLE walls ADD COLUMN exclude_terms TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE walls ADD COLUMN exclude_policy TEXT NOT NULL DEFAULT 'reject';
  `,
  // version 4: 会場モニターの画面モード。既存行は既定値 (通常モード) で始まる。
  // 任意画像の実体はファイルに置き、ここにはメタ (ファイル名・MIME・更新時刻) だけ持つ。
  `
  ALTER TABLE walls ADD COLUMN screen TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE walls ADD COLUMN screen_image TEXT;
  `,
];

/** DB を最新スキーマまでマイグレーションする。 */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const currentVersion = row?.user_version ?? 0;

  for (let version = currentVersion + 1; version <= MIGRATIONS.length; version += 1) {
    const ddl = MIGRATIONS[version - 1];
    if (ddl === undefined) continue;
    db.exec('BEGIN');
    try {
      db.exec(ddl);
      // user_version はプレースホルダを受け付けないため直接埋め込む (数値のみなので安全)
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
