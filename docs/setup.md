# セットアップ (Node で直接動かす)

会場の PC や 1 台のサーバーで、Node.js のアプリケーションとして動かす手順です。
コンテナで動かす場合は [docker.md](./docker.md)、リモート公開するときの
プロキシ・TLS・認証は [deployment.md](./deployment.md) を参照してください。

## 1. 必要なもの

| | 要件 | 確認 |
| --- | --- | --- |
| Node.js | 24 以上 | `node --version` |
| pnpm | 10 以上 (corepack で入る) | `pnpm --version` |
| ネットワーク | 送信方向のみ。Jetstream (wss) と Bluesky の AppView (https) へ出られること | |

会場のネットワークが送信方向を塞いでいると投稿を受信できません。事前に
`wss://jetstream2.us-east.bsky.network` と `https://public.api.bsky.app` へ
到達できるか確認してください。

```bash
corepack enable   # pnpm を使えるようにする (Node に同梱)
```

### 必要スペック (実測)

1 イベント (1 テナント / ウォール数個) を想定した値です。

| | 最低 | 推奨 | 備考 |
| --- | --- | --- | --- |
| CPU | 1 コア | 2 コア | 受信して振り分けるだけなので、平常時は数 % 程度 |
| メモリ | 256MB | 512MB | 実測 80〜130MB (既定の `BUFFER_SIZE=200`、キーワード 3 語で毎分 100 件以上を受信した状態) |
| ディスク | 400MB | 1GB | 内訳は下表 |

メモリは表示中・承認待ちの投稿を保持する分が効きます。`BUFFER_SIZE` や
`BACKLOG_SIZE` を大きくする場合は比例して増やしてください。

| 用途 | 容量 | 備考 |
| --- | --- | --- |
| ソース + `node_modules` (開発込み) | 約 246MB | ビルドするホストに必要 |
| `node_modules` (production のみ) | 約 148MB | 実行に必要な分 |
| ビルド成果物 (`dist/` + `public/`) | 約 3MB | 管理画面のフォント込み |
| CI 成果物の tar.gz | 約 1MB | 依存を含まない配布物 |
| テナント設定 (`wall.db`) | 数百 KB | `MULTI_TENANT=true` のとき。テナント / ウォール数に比例 |
| 画像 (`uploads/`) | ウォールあたり最大 2MB | 画面モードで画像を使うとき |

投稿はディスクに書きません (メモリ上のリングバッファのみ)。ログは journald か
コンテナのログドライバ側の設定に従います。

## 2. 取得とビルド

```bash
git clone https://github.com/anon5r/bsky-live-wall.git
cd bsky-live-wall

pnpm install --frozen-lockfile
pnpm build        # サーバー (tsc) と管理画面 (Vite) をまとめてビルドする
```

`pnpm build` は次の 2 つを作ります。どちらも実行に必要です。

- `dist/` — サーバー
- `public/admin/` — ビルド済みの管理画面 (`src/admin` から生成。CDN は使いません)

> CI で作った成果物 (`bsky-live-wall-<sha>.tar.gz`) を置く場合は、ビルドの道具は
> 要りません。[docs/deployment.md の「ビルド済みの成果物を置く場合」](./deployment.md)
> を参照してください。

## 3. 設定

```bash
cp .env.example .env
```

最低限、次の 2 つを決めます。

```dotenv
# 監視するハッシュタグ (カンマ区切り)。空でも起動でき、管理画面から後で足せる
HASHTAGS=myevent2026
# 会場モニターのヘッダに出すイベント名
EVENT_TITLE=My Event 2026
```

**会場 PC で完結する場合 (ローカル運用)** は、これだけで動きます。管理 API は
loopback からのアクセスに限り、トークンなしで通ります。

**同じ LAN の別端末から管理画面を開く場合や、インターネットへ公開する場合**は
認証が必須です。

```dotenv
# openssl rand -hex 32 で生成する
ADMIN_TOKEN=...
# リバースプロキシ配下なら必ず true (実クライアント IP の判定に使う)
TRUST_PROXY=true
```

`TRUST_PROXY=true` かつ `ADMIN_TOKEN` 未設定では**起動を拒否します**。プロキシ経由の
アクセスがすべて loopback と誤認され、管理 API が素通しになるためです。

項目の一覧と既定値は [`.env.example`](../.env.example) にあります。よく使うものは
README の「設定」の表にまとめています。

### 保存先 (使う場合だけ)

| 変数 | 既定 | 使う場面 |
| --- | --- | --- |
| `DATA_FILE` | `./data/wall.db` | `MULTI_TENANT=true` のとき。テナント・ウォール・メンバーを保存する |
| `UPLOAD_DIR` | `./data/uploads` | 会場モニターに出す画像 (QR など) を保存する |

単一テナント運用で画像も使わないなら、状態はすべてメモリ上にあり、書き込み先は
要りません。この場合ディスクは読み取り専用でも動きます。

## 4. 起動

```bash
# 開発中 (ソースの変更で再起動する)
pnpm dev

# そのまま動かす
node dist/index.js
```

| URL | 用途 |
| --- | --- |
| `http://localhost:3000/wall` | 会場モニター (ブラウザを全画面にする) |
| `http://localhost:3000/admin` | 管理画面 |
| `http://localhost:3000/api/health` | ヘルスチェック |

マルチテナント運用 (`MULTI_TENANT=true`) では URL にテナントが入ります
(`/e/<tenant>/wall/<wallId>`)。詳細は [multi-tenant-design.md](./multi-tenant-design.md)。

### 動作確認

1. 管理画面を開き、「状態」で Jetstream が **接続中** になっていること
2. 監視しているハッシュタグを付けて Bluesky へ投稿する
3. 数秒で会場モニターに出ること (キーワードのみ一致した投稿は既定で承認待ちに入ります)

出ない場合は [operations.md](./operations.md) のトラブルシュートを参照してください。

## 5. 常時起動 (systemd)

`deploy/bsky-live-wall.service` に、権限を絞った unit を用意しています
(`ProtectSystem=strict` / `NoNewPrivileges` など)。

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bskywall
sudo chown -R bskywall:bskywall /opt/bsky-live-wall

sudo cp deploy/bsky-live-wall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bsky-live-wall
systemctl status bsky-live-wall
journalctl -u bsky-live-wall -f
```

`DATA_FILE` や `UPLOAD_DIR` を使う場合は、その置き場を unit の `ReadWritePaths` に
加えてください (既定は読み取り専用で動く前提の設定になっています)。

## 6. 更新

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart bsky-live-wall   # systemd で動かしている場合
```

管理画面は `public/admin/` のビルド成果物を配信するため、**`pnpm build` を忘れると
古い管理画面のまま**になります。サーバーだけ再起動しても変わりません。

## 7. よくある詰まり

| 症状 | 原因と対処 |
| --- | --- |
| 起動しない (`ADMIN_TOKEN` のエラー) | `TRUST_PROXY=true` ならトークンが必須。`openssl rand -hex 32` で設定する |
| 管理画面が真っ白 | `pnpm build` を実行していない (`public/admin/` が無い) |
| Jetstream が「切断」のまま | 送信方向の wss が塞がれている。`JETSTREAM_HOSTS` の別ホストも試す |
| 投稿が出ない | ハッシュタグの綴り、または承認待ちに入っていないか管理画面で確認する |
| ポートが使われている | `PORT` を変える。既定は 3000 |
