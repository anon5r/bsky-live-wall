# 作業分割

共有契約 (`src/shared/`, `.env.example`, `package.json`, `tsconfig.json`) は先に確定させ、
以降の 3 タスクは互いのファイルに触れずに並行実装する。

| ID | 担当領域 | 触るファイル | 前提 |
| --- | --- | --- | --- |
| T0 | 共有契約 | `src/shared/**`, 設定ファイル群 | なし |
| T1 | Ingest | `src/ingest/**` | T0 |
| T2 | Server | `src/server/**`, `src/index.ts` | T0 |
| T3 | 会場モニター UI | `public/wall/**` | T0 (API 契約) |
| T4 | 管理画面 UI | `public/admin/**` | T0 (API 契約) |
| T5 | 結合・動作確認 | 全体 | T1-T4 |

## API 契約 (T2 / T3 / T4 が共有する取り決め)

### `GET /api/stream` (SSE)

| event | data | 説明 |
| --- | --- | --- |
| `hello` | `{ hashtags, backlog: WallPost[], stats }` | 接続直後に 1 回 |
| `post` | `WallPost` | 新着投稿 |
| `history` | `WallPost[]` | バックフィルで確定した過去の投稿 (新しい順)。既存カードの下へ積む |
| `profile` | `{ did, profile }` | 後追いで解決したプロフィール |
| `remove` | `{ uri }` | 削除・非表示 |
| `state` | `WallState` | 一時停止状態・接続状態の変化 |
| `ping` | `{ t }` | 15 秒ごと |

### `GET /api/posts?limit=30`

`{ posts: WallPost[], stats: WallStats }`

### 管理 API

認証は 2 経路。管理画面はセッション Cookie、スクリプトは `Authorization: Bearer <ADMIN_TOKEN>`。
Cookie 認証では状態変更操作に `X-Requested-With: bsky-live-wall` ヘッダが必要 (CSRF 対策)。

| メソッド | パス | body | 説明 |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | - | 受け付ける認証方式 (`{ oauth, token }`) |
| POST | `/api/auth/login` | `{ handle: string }` | OAuth の認可 URL を返す |
| GET | `/api/auth/callback` | - | OAuth のコールバック。許可リスト照合後にセッション発行 |
| GET | `/client-metadata.json` | - | OAuth クライアントメタデータ |
| GET | `/api/admin/actors` | - | 管理を許可されたアカウント一覧 |
| POST | `/api/admin/actors/reload` | - | 許可リスト再読み込み (外れたアカウントは即失効) |
| POST | `/api/admin/session` | `{ token: string }` | トークンログイン。HttpOnly Cookie を発行 |
| DELETE | `/api/admin/session` | - | ログアウト |
| GET | `/api/admin/sessions` | - | ログイン中のセッション一覧 |
| POST | `/api/admin/sessions/revoke-all` | - | 全セッション失効 |
| GET | `/api/admin/audit` | - | 監査ログ (直近 200 件) |


| メソッド | パス | body | 説明 |
| --- | --- | --- | --- |
| GET | `/api/admin/state` | - | 状態取得 (`state` / `recent` / `pending` / `hidden` / `blocked`) |
| POST | `/api/admin/pause` | `{ paused: boolean }` | 一時停止 |
| POST | `/api/admin/hide` | `{ uri: string }` | 個別非表示 |
| POST | `/api/admin/approve` | `{ uri: string }` | 承認モード時の公開 |
| POST | `/api/admin/unhide` | `{ uri: string }` | 非表示の復元 |
| POST | `/api/admin/block` | `{ did: string }` | 投稿者ブロック |
| POST | `/api/admin/unblock` | `{ did: string }` | ブロック解除 (取り下げた投稿も復元) |
| POST | `/api/admin/clear` | - | 表示中の全消去 |
