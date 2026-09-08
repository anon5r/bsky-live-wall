# bsky-live-wall

Bluesky の特定ハッシュタグ付き投稿を **Jetstream v2** からリアルタイム受信し、
イベント会場のモニター／スクリーンに大きく流し続けるライブウォールです。

- サーバーサイドで動作する Node.js アプリ 1 プロセスで完結します。
- 会場モニターはブラウザを全画面にするだけ。ページ更新なしで流れ続けます。
- Bluesky アカウントの認証情報は不要です (公開エンドポイントのみを使用)。

## 必要環境

- Node.js 20 以上 (開発は 24 で確認)
- pnpm (npm / yarn でも可)
- 会場 PC からインターネットへの WebSocket 接続 (`wss://jetstream*.bsky.network`)

## セットアップ

```bash
git clone <このリポジトリ>
cd bsky-live-wall
pnpm install
cp .env.example .env
```

`.env` の `HASHTAGS` をイベントのハッシュタグに書き換えます。

```dotenv
HASHTAGS=myevent2026
EVENT_TITLE=My Event 2026
EVENT_SUBTITLE=Tokyo / Hall A
```

## 起動

```bash
# 開発 (ファイル変更で自動再起動)
pnpm dev

# 本番
pnpm build
pnpm start
```

| URL | 用途 |
| --- | --- |
| `http://localhost:3000/wall` | **会場モニター用**。ブラウザで開いて F11 で全画面にする |
| `http://localhost:3000/admin` | 運営用の管理画面 |
| `http://localhost:3000/api/health` | ヘルスチェック |

## 会場モニターの表示オプション

URL クエリで `.env` の設定を上書きできます。

| クエリ | 例 | 説明 |
| --- | --- | --- |
| `columns` | `?columns=4` | カラム数 |
| `max` | `?max=30` | 同時表示カード数 |
| `theme` | `?theme=light` | ライトテーマ |
| `noimages` | `?noimages=1` | 画像を表示しない |
| `demo` | `?demo=1` | ダミー投稿で表示確認 (リハーサル用) |

## 設定

すべて `.env` で指定します。項目の一覧と既定値は [`.env.example`](./.env.example) を参照してください。
主なものは以下です。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `HASHTAGS` | `bskyevent` | 監視するハッシュタグ (カンマ区切りで複数可) |
| `MODERATION_MODE` | `open` | `approve` にすると運営が承認した投稿だけを表示 |
| `NG_WORDS` / `NG_PATTERNS` | 空 | 除外する語 / 正規表現 |
| `BLOCK_ACTORS` | 空 | 除外する DID / ハンドル |
| `ALLOW_REPLIES` | `true` | リプライを表示するか |
| `FILTER_LABELED` | `true` | 成人向けラベル付き投稿を除外するか |
| `WALL_COLUMNS` | `3` | カラム数 |
| `WALL_MAX_CARDS` | `24` | 同時表示カード数 |
| `ADMIN_TOKEN` | 空 | 管理 API のトークン。空の場合は localhost からのみ操作可 |

## 仕組み

```text
Bluesky --(WebSocket: Jetstream v2)--> [ingest] タグ判定 -> モデレーション -> リングバッファ
                                                                       |
                                          [server] Fastify --(SSE)--> 会場モニター / 管理画面
```

- タグ判定は投稿レコードの `facets` (richtext tag)、`tags` フィールド、本文中の `#タグ` の 3 経路を
  NFKC 正規化 + 小文字化して照合します。日本語タグにも対応します。
- 投稿の削除 (`delete` コミット) を受信すると、会場モニターからも即座に取り下げます。
- 投稿者のプロフィール (表示名・アバター) は公開 AppView から非同期に取得し、解決後に差分だけを配信します。
  取得できなくても投稿の表示は止まりません。

詳細は [docs/architecture.md](./docs/architecture.md) を参照してください。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/requirements.md](./docs/requirements.md) | 要件定義 |
| [docs/architecture.md](./docs/architecture.md) | アーキテクチャと設計判断 |
| [docs/operations.md](./docs/operations.md) | イベント当日の運用手順 |
| [docs/task-breakdown.md](./docs/task-breakdown.md) | 作業分割と API 契約 |

## カスタムフィード (任意機能)

`FEED_GENERATOR_ENABLED=true` にすると、AT Protocol のカスタムフィード
(`app.bsky.feed.getFeedSkeleton`) を公開します。参加者が Bluesky アプリからも同じタグを
追えるようになりますが、公開するにはグローバルにアクセス可能な HTTPS ホスト名と
`did:web` の設定、フィードの publish 作業が別途必要です。会場内だけで使う場合は不要です。

## ライセンス

MIT

## テスト

```bash
pnpm test
```

タグ判定 (`src/ingest/hashtag-matcher.ts`) とモデレーション (`src/ingest/moderator.ts`) の
純粋ロジックを対象にした単体テストが `test/` にあります。ビルド成果物 (`dist/`) に対して実行します。
