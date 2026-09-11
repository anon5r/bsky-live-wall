# Docker で動かす

コンテナで動かすときの設定をまとめます。Node で直接動かす場合は
[setup.md](./setup.md)、公開時のプロキシ・TLS・認証は [deployment.md](./deployment.md)
を参照してください。

## 選択肢

| 方法 | 向いている場面 |
| --- | --- |
| **Compose (Caddy 付き)** | インターネットへ公開する。TLS の取得・更新まで任せたい |
| **Compose (アプリだけ)** | 既にプロキシがある。TLS は別で終端している |
| **`docker run`** | 1 台で試す。オーケストレーションが別にある |
| **公開イメージ (ghcr.io)** | ビルドせずに配布物を使う |

## イメージ

`Dockerfile` は 2 段構成です。ビルド段で `pnpm build` (サーバー + 管理画面) を実行し、
実行段には `dist/` `public/` `node_modules` (production のみ) だけを置きます。

- ベース: `node:24-alpine`、実行ユーザーは非 root (`node`, uid 1000)
- サイズ: 約 245MB (arm64 で実測。内訳は `node_modules` 148MB / `public` 2.3MB / `dist` 0.7MB)
- `HEALTHCHECK` 内蔵 (`/api/health` を Node の fetch で叩く)。`docker ps` の STATUS で分かる
- PID 1 として動くため、アプリ側で SIGTERM を処理している

### 必要スペック (実測)

| | 最低 | 推奨 | 備考 |
| --- | --- | --- | --- |
| CPU | 1 コア | 2 コア | 平常時は数 % 程度 |
| メモリ | 256MB | 512MB | 実測 80〜130MB。`compose.yaml` は 512M 制限 |
| ディスク | 1GB | 2GB | イメージ 245MB + ボリューム + ログ |

ボリューム (`/app/data`) に入るのは、テナント設定の SQLite (数百 KB) と画像
(ウォールあたり最大 2MB) だけです。投稿はディスクに書きません。ログは
`compose.yaml` で 10MB × 3 に制限しています。

Caddy も動かす場合は、証明書用に別途 50MB ほど見ておいてください。

### 自分でビルドする

```bash
docker build -t bsky-live-wall .
```

### 公開イメージを使う

`main` への push とタグで、GitHub Actions が `ghcr.io` へ push します。

```bash
docker pull ghcr.io/anon5r/bsky-live-wall:latest
```

| タグ | 中身 |
| --- | --- |
| `latest` | `main` の最新 |
| `1.2.3` / `1.2` / `1` | タグ `v1.2.3` を打った時点 |
| `sha-xxxxxxx` | コミット指定 |

## 永続化 (重要)

書き込むのは次の 2 つだけです。**使う構成なら必ずボリュームを当ててください。**
コンテナを作り直すと消えます。

| パス | 中身 | 必要な構成 |
| --- | --- | --- |
| `/app/data/wall.db` | テナント・ウォール・メンバー・監視語などの設定 (SQLite) | `MULTI_TENANT=true` |
| `/app/data/uploads/` | 会場モニターに出す画像 (QR など) | 画面モードで画像を使うとき |

`compose.yaml` は `/app/data` に名前付きボリューム `wall_data` を当てています。
イメージ側で `node` 所有のディレクトリを用意してあるため、`read_only: true` の
ままでもここだけは書けます。

単一テナント運用で画像も使わない場合、状態はすべてメモリ上にあり、ボリュームは
空のままです (当てておいて困ることはありません)。

## 1. Compose (Caddy 付き)

TLS は Caddy が自動取得します。公開するホスト名の DNS がこのサーバーを指していて、
80 / 443 がインターネットから到達できることが前提です。

```bash
git clone https://github.com/anon5r/bsky-live-wall.git
cd bsky-live-wall
cp .env.example .env
```

`.env` を編集します。

```dotenv
HASHTAGS=myevent2026
EVENT_TITLE=My Event 2026

# リモート公開に必須 (openssl rand -hex 32)
ADMIN_TOKEN=...

# compose.yaml が参照する公開ホスト名
WALL_DOMAIN=wall.example.com
```

`TRUST_PROXY=true` は `compose.yaml` 側で設定済みなので `.env` には不要です。

```bash
docker compose up -d
docker compose logs -f app
```

| URL | 用途 |
| --- | --- |
| `https://wall.example.com/wall` | 会場モニター |
| `https://wall.example.com/admin` | 管理画面 |
| `https://wall.example.com/api/health` | ヘルスチェック |

### コンテナの中身

- `app` — 本体。ホストへはポートを公開せず、Caddy 経由のみ (`expose`)
- `caddy` — TLS 終端とリバースプロキシ。設定は `deploy/Caddyfile`

`app` には次の制限を掛けています。

```yaml
read_only: true                 # /tmp と /app/data 以外は書けない
security_opt: [no-new-privileges:true]
deploy.resources.limits.memory: 512M
logging: json-file (10MB × 3)
```

## 2. Compose (アプリだけ)

既にプロキシがある場合は `caddy` を使わず、アプリだけを動かします。

```yaml
# compose.override.yaml
services:
  app:
    ports:
      # ホストの loopback にだけ公開し、外部への露出はプロキシ側で制御する
      - "127.0.0.1:3000:3000"

  caddy:
    profiles: ["donotstart"]
```

```bash
docker compose up -d app
```

## 3. `docker run`

```bash
docker volume create bsky_wall_data

docker run -d --name bsky-live-wall \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -e TRUST_PROXY=true \
  -e HOST=0.0.0.0 \
  -v bsky_wall_data:/app/data \
  --read-only --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  --memory 512m \
  ghcr.io/anon5r/bsky-live-wall:latest
```

`-p 127.0.0.1:3000:3000` でホストの loopback にのみ公開し、外部への露出は
リバースプロキシ側で制御します。

## 環境変数

すべて `.env` (または `-e`) で渡します。一覧と既定値は
[`.env.example`](../.env.example)。コンテナで特に関係するものは次のとおりです。

| 変数 | コンテナでの値 | 備考 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | コンテナ外から届くようにする。`compose.yaml` で設定済み |
| `PORT` | `3000` | 変えるなら公開ポートも合わせる |
| `TRUST_PROXY` | `true` | プロキシ配下では必須。`ADMIN_TOKEN` とセットで設定する |
| `ADMIN_TOKEN` | 必須 | `TRUST_PROXY=true` で未設定だと起動しない |
| `DATA_FILE` | `./data/wall.db` | 既定のままで `/app/data` (ボリューム) に載る |
| `UPLOAD_DIR` | `./data/uploads` | 同上 |
| `PUBLIC_URL` | `https://wall.example.com` | OAuth を使う場合に必須 |

## 運用

### 設定を変えたとき

`.env` は起動時にしか読まれません。

```bash
docker compose up -d --force-recreate app
```

### 更新

```bash
# 自分でビルドしている場合
git pull
docker compose build app
docker compose up -d app

# 公開イメージを使っている場合
docker compose pull app
docker compose up -d app
```

ボリュームを当てていれば、設定と画像は作り直しても残ります。

### ログと状態

```bash
docker compose logs -f app          # 受信・承認・設定変更のログ
docker compose ps                   # STATUS の (healthy) を確認
docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(console.log)"
```

### バックアップ

`MULTI_TENANT=true` で運用している場合、消えて困るのは `/app/data` だけです。

```bash
docker run --rm -v bsky-live-wall_wall_data:/data -v "$PWD:/backup" alpine \
  tar -czf /backup/wall-data.tar.gz -C /data .
```

SQLite は WAL モードで動いています。停止中に取るのが確実です。

## よくある詰まり

| 症状 | 原因と対処 |
| --- | --- |
| 起動直後に落ちる (`ADMIN_TOKEN` のエラー) | `TRUST_PROXY=true` ならトークンが必須 |
| 設定がコンテナの作り直しで消える | `/app/data` にボリュームを当てていない |
| 画像をアップロードすると失敗する | 同上。`read_only` のまま `/app/data` が無いと書けない |
| 管理画面が古いまま | イメージを作り直していない (`docker compose build app`) |
| `docker ps` が unhealthy | `HEALTHCHECK` が `/api/health` に届いていない。`PORT` を変えたなら合わせる |
| Jetstream が「切断」のまま | 送信方向の wss が塞がれている。ホスト側のファイアウォールを確認する |
