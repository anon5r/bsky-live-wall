# アーキテクチャ

## 1. 全体構成

```text
  Bluesky Network
        |
        | WebSocket (Jetstream v2)
        v
+-------------------------------------------------------+
|  bsky-live-wall (Node.js 単一プロセス)                 |
|                                                       |
|  [ingest]                                             |
|   JetstreamClient (ライブ) --+                          |
|   BackfillReader  (過去) ----+-> HashtagMatcher         |
|                                    -> Moderator        |
|         |                                             |
|         v                                             |
|   ProfileHydrator (public.api.bsky.app, TTL cache)     |
|         |                                             |
|         v                                             |
|   PostStore (リングバッファ + EventEmitter)            |
|         |                                             |
|  [server]                                             |
|   Fastify                                             |
|    +-- GET /api/stream        (SSE: 会場モニター向け)  |
|    +-- GET /api/posts         (バックログ JSON)        |
|    +-- POST /api/admin/*      (運営操作)               |
|    +-- GET /xrpc/app.bsky.feed.getFeedSkeleton (任意)  |
|    +-- static /wall, /admin                            |
+-------------------------------------------------------+
        |                        |
        | SSE                    | SSE
        v                        v
  会場モニター (全画面)     運営端末 (管理画面)
```

## 2. モジュール境界

| ディレクトリ | 責務 | 依存してよいもの |
| --- | --- | --- |
| `src/shared/` | 型定義・設定ローダ・ロガー・ユーティリティ。他モジュールから参照される唯一の共有点 | なし |
| `src/ingest/` | Jetstream 受信、タグ判定、モデレーション、プロフィール補完、PostStore | `src/shared/` |
| `src/server/` | HTTP/SSE、管理 API、静的配信、フィードジェネレータ | `src/shared/`, `src/ingest/` の公開インターフェース |
| `public/wall/` | 会場モニター用フロントエンド (依存なしの素の HTML/CSS/JS) | `/api/stream` の契約のみ |
| `public/admin/` | 運営用フロントエンド | `/api/admin/*` の契約のみ |

**原則**: `src/ingest/` は HTTP を知らない。`src/server/` は Jetstream を知らない。両者は `PostStore` の
イベント (`post`, `remove`, `state`) だけで結合する。

## 3. データフロー

1. `JetstreamClient` が `commit` イベントを受信。
2. `operation === 'create' && collection === 'app.bsky.feed.post'` を通過させる。
3. `HashtagMatcher` が facets / tags / text から対象タグを判定。不一致は破棄。
4. `Moderator` が NG ワード・ブロック DID・ラベル・リプライ設定で判定。破棄またはフラグ付与。
5. `ProfileHydrator` が DID からプロフィールを解決 (キャッシュミス時はバッチキューに投入)。
6. `PostStore.add()` がリングバッファへ格納し `post` イベントを発火。
7. `SseHub` が接続中の全クライアントへ JSON 1 行を push。
8. ブラウザが `EventSource` で受信し、カードを DOM に挿入。

`operation === 'delete'` の場合は `PostStore.remove(uri)` を呼び、`remove` イベントを push する。

## 4. 主要な設計判断

| 判断 | 理由 |
| --- | --- |
| WebSocket ではなく SSE でクライアント配信 | 通信は片方向のみ。`EventSource` が自動再接続と `Last-Event-ID` を標準で持ち、長時間の無人稼働に強い |
| 状態はメモリのリングバッファ | イベント中の一時表示が目的。DB を持たないことで運用コストとレイテンシを下げる |
| プロフィール取得は公開 AppView | 認証情報なしで動く。イベント当日にアカウント都合で止まるリスクを排除する |
| プロフィール解決を非ブロッキング化 | 解決前でもハンドルのみで先に表示し、解決後に `profile` 差分イベントで更新する |
| バックフィルをライブ接続と分離 | 1 本の接続で過去から再生すると現在に追いつくまで数十秒間ライブ投稿が届かない。別接続にすることでライブは常に 1 秒以内に届く |
| バックフィル分を取り込み完了まで保留 | 再生の途中で削除コミットが来る投稿を、一度表示してから消すちらつきが起きる。保留してから確定分だけを送ることで削除済みの投稿を一切表示しない |
| フロントエンドはビルド不要の素の JS | 会場 PC で `git clone` して即動かせる。ビルド失敗という当日の障害要因を消す |
| Font Awesome を CDN ではなく自前配信 | 会場のネットワークが不安定でもアイコンが確実に出る。閲覧者の情報が第三者へ渡ることも防げる |

## 5. 障害時の挙動

| 事象 | 挙動 |
| --- | --- |
| Jetstream 切断 | 指数バックオフ再接続。`cursor` で取りこぼしを補填。ウォール上部のステータスが「再接続中」に変わる |
| Jetstream ホスト障害 | 連続失敗でフォールバックホストへ切り替え |
| AppView 障害 | プロフィール未解決のまま DID/ハンドルで表示を継続。投稿は止めない |
| ブラウザ切断 | `EventSource` が自動再接続。再接続時にバックログを再送し画面を復元 |
| メモリ増大 | リングバッファ上限 + DOM ノード上限で頭打ちにする |

## 6. 設定 (環境変数)

`.env.example` を正とする。すべて既定値を持ち、`HASHTAGS` のみ実質必須。
