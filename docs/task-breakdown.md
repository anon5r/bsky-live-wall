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
| `profile` | `{ did, profile }` | 後追いで解決したプロフィール |
| `remove` | `{ uri }` | 削除・非表示 |
| `state` | `WallState` | 一時停止状態・接続状態の変化 |
| `ping` | `{ t }` | 15 秒ごと |

### `GET /api/posts?limit=30`

`{ posts: WallPost[], stats: WallStats }`

### 管理 API (すべて `Authorization: Bearer <ADMIN_TOKEN>`)

| メソッド | パス | body | 説明 |
| --- | --- | --- | --- |
| GET | `/api/admin/state` | - | 状態取得 |
| POST | `/api/admin/pause` | `{ paused: boolean }` | 一時停止 |
| POST | `/api/admin/hide` | `{ uri: string }` | 個別非表示 |
| POST | `/api/admin/approve` | `{ uri: string }` | 承認モード時の公開 |
| POST | `/api/admin/block` | `{ did: string }` | 投稿者ブロック |
| POST | `/api/admin/clear` | - | 表示中の全消去 |
