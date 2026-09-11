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
|  [ingest] WallManager                                 |
|   JetstreamClient (ライブ) --+                          |
|   BackfillReader  (過去) ----+-> 各ウォールの監視語と照合   |
|                                    -> Moderator (共通)  |
|                                    -> Wall A / B / C   |
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
| ウォールが増えても Jetstream 接続は 1 本 | 接続を分けると同じ全量を何度も受信することになり、帯域と相手側の負荷が無駄に増える。実測流量は約 27 件/秒で、照合の CPU は問題にならない |
| モデレーションは全ウォール共通 | 荒らしを 1 回ブロックすればすべてのモニターから消える。画面ごとに個別操作を求めるのは運用上危険 |
| バックフィルをライブ接続と分離 | 1 本の接続で過去から再生すると現在に追いつくまで数十秒間ライブ投稿が届かない。別接続にすることでライブは常に 1 秒以内に届く |
| バックフィル分を取り込み完了まで保留 | 再生の途中で削除コミットが来る投稿を、一度表示してから消すちらつきが起きる。保留してから確定分だけを送ることで削除済みの投稿を一切表示しない |
| 会場モニターはビルド不要の素の JS | 会場 PC で `git clone` して即動かせる。ビルド失敗という当日の障害要因を消す。管理画面のみ Svelte を使い、当日の表示経路には依存を持ち込まない |
| サーバーは Fastify のまま維持 | Hono の利点はエッジランタイムへの可搬性だが、Cloudflare Workers は不適と結論済みで移植先がない。SSE の hijack・Cookie 認証・実 IP 判定など検証を積んだ箇所を書き直す risk に見合わない |
| Font Awesome を CDN ではなく自前配信 | 会場のネットワークが不安定でもアイコンが確実に出る。閲覧者の情報が第三者へ渡ることも防げる |
| 管理画面のみ Svelte + Web Awesome を使う | タブ・スイッチ・ダイアログ・フォーム部品を自前で保守し続けるコストを避ける。会場モニターは依存ゼロのまま維持し、当日の障害要因を増やさない |
| `<wa-icon>` は使わず `<i class="fa-solid">` を使う | アイコンの取得元設定を持ち込まずに済み、オフライン動作の保証が崩れない |

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

## 7. URL 空間

マルチテナント化を見据えた設計です。**イベント (テナント) の階層は、現状 1 イベントしか
なくても経路に組み込んであります。** 後から挿入すると既存の URL がすべて変わるためです。

```text
/assets/...                      静的ファイル (ここに閉じ込める)
/wall                            既定イベントの既定ウォール
/wall/<wallId>                   既定イベントの個別ウォール
/admin                           既定イベントの管理画面
/api/...                         既定イベントの API
/e/<eventId>/wall                イベントを明示
/e/<eventId>/wall/<wallId>
/e/<eventId>/admin
/e/<eventId>/api/...
/client-metadata.json            OAuth (イベントに属さない)
/.well-known/did.json            フィードジェネレータ (同上)
/xrpc/...                        AT Protocol の規約上ルート直下
```

### 設計判断

| 判断 | 理由 |
| --- | --- |
| 静的ファイルを `/assets/` に閉じ込める | ルート直下に置くと `/wall/<wallId>` のような可変の経路と衝突する。実際に `/wall/wall.js` がウォール ID と誤認される問題が起きた。ID の文字種で回避するのは対症療法にすぎない |
| イベント階層を先に用意する | 後から `/e/<id>/` を挿入すると、掲示物や配信のオーバーレイ設定に書かれた URL がすべて無効になる |
| 短い経路 (`/wall`) も残す | 会場で口頭や掲示で伝えるのは短いほうがよい。既定イベントへの別名として維持する |
| OAuth とフィードはイベント階層に載せない | `client_id` と `did:web` は固定 URL である必要がある |
| 予約語を定義する (`RESERVED_SLUGS`) | ウォール ID が `admin` や `api` になると URL が曖昧になる。作成時に弾く |

### 認証への影響

同じ管理 API が `/api/admin/...` と `/e/<eventId>/api/admin/...` の両方に登録されます。
認証ガードが `request.url` の前方一致で判定していると、**階層付きの経路が素通り**します。
登録時のルートパターン (`request.routeOptions.url`) で判定してください。

### 運用モードによる違い

| | 単一テナント (`MULTI_TENANT=false`) | マルチテナント (`true`) |
| --- | --- | --- |
| 会場モニター | `/wall`, `/wall/<wallId>` | `/e/<tenant>/wall/<wallId>` |
| 管理画面 | `/admin` | `/admin` (入口) と `/e/<tenant>/admin` (直リンク) |
| `/e/<id>/...` | 別名として使える | 唯一の形 |
| `/wall` (テナントなし) | 既定ウォール | `/admin` へ転送 |

管理画面の入口を両モードで `/admin` に統一しているのは、ログイン前にどのテナントを
操作するか決まっていないためです。ログイン後にテナントを選び、以降は
`/e/<tenant>/admin` へ深いリンクを張れます。

`/e/<tenant>/admin` から OAuth でログインした場合は、そのテナントの管理画面へ戻します。
管理画面が `POST /api/auth/login` に現在の経路 (`returnTo`) を渡し、サーバーはそれを
OAuth の `state` に載せてコールバックで復元します。戻り先は `/admin` と
`/e/<tenant>/admin` の形だけを許可し、それ以外は `/admin` に落とします
(オープンリダイレクトを作らないため)。

### 将来のマルチテナント化

`/e/<eventId>` の解決を「設定から読んだ 1 件」から「イベントの一覧を引く」に差し替えるだけで
テナントを増やせます。サブドメイン方式 (`<tenant>.example.com`) が必要になった場合も、
リバースプロキシで同じ経路に書き換えれば対応できます。
