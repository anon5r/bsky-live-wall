# デプロイ手順 (コンテナ / LXC / リモート公開)

会場 PC でのローカル運用については [README](../README.md) を参照してください。
本書はサーバーで常時稼働させ、リモートから利用する場合の手順です。

## 0. リモート公開する前に必ず読む

ローカル運用とリモート公開では、必要な設定が異なります。

| 項目 | ローカル運用 | リモート公開 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 空でよい (localhost からのみ操作可) | **必須** (`AUTH_MODE=oauth` なら不要) |
| `TRUST_PROXY` | `false` | **`true`** (リバースプロキシ配下の場合) |
| TLS | 不要 | **必須** |

### なぜ `TRUST_PROXY` が必要か

`ADMIN_TOKEN` が空のとき、管理 API は「loopback アドレスからのアクセスのみ許可」で保護されます。
ところが**リバースプロキシを挟むと、リモートの利用者もプロキシの loopback アドレスとして
見えてしまいます。** この状態を放置すると、インターネット上の誰もが管理 API を操作できます。

`TRUST_PROXY=true` にすると、

1. `X-Forwarded-For` から実クライアント IP を判定するようになる
2. トークンなしの loopback 例外が**無効化**される
3. `ADMIN_TOKEN` が未設定なら**起動を拒否する**

という保護が入ります。プロキシ配下では必ず有効にしてください。

### トークンの生成

```bash
openssl rand -hex 32
```

### 認証方式を選ぶ

| `AUTH_MODE` | 内容 | 向き |
| --- | --- | --- |
| `token` (既定) | `ADMIN_TOKEN` によるログイン | 会場 PC での単独運用 |
| `oauth` | **AT Protocol アカウント (Bluesky) でログイン** | リモート公開・共同運用 |
| `both` | 両方を受け付ける | 移行期間 |

**リモート公開では `oauth` を推奨します。** 共有トークンと違い、個人単位で識別・許可・失効
できます。

#### OAuth の設定

```dotenv
AUTH_MODE=oauth

# 公開 URL (末尾スラッシュなし)。client_id とコールバック URL の組み立てに使う
PUBLIC_URL=https://wall.example.com

# 管理を許可するアカウント。招待制の実体
ADMIN_ACTORS=alice.bsky.social,bob.example.com
```

起動時に以下を検証し、満たさない場合は**起動を拒否**します。

- `PUBLIC_URL` が設定されていること
- `PUBLIC_URL` が https であること (localhost 開発時のみ `OAUTH_ALLOW_HTTP=true` で回避)
- `ADMIN_ACTORS` が空でないこと (空だと最初の 1 人がログインできない。
  以後は管理画面から招待したメンバーも `.env` を触らずにログインできる)

#### 認証と認可を分けている

OAuth が保証するのは「本人であること」だけです。**管理してよいかは `ADMIN_ACTORS` の
許可リストで決めます。** Bluesky アカウントを持つ誰もがログインを試せますが、
リストにない DID はセッションを発行せずに拒否します。

ハンドルは変更され得るため、許可判定は起動時に解決した **DID** で行います。
`ADMIN_ACTORS` には DID を直接書くこともできます。

#### 要求する権限

スコープは `atproto` のみです。本システムは利用者に代わって投稿したりデータを読んだり
しないため、それ以上の権限を要求しません。**パスワードは本システムに入力されません。**
認証は利用者自身の PDS で行われます。

#### 運用中の許可リスト変更

`.env` を書き換えたあと、管理画面から `POST /api/admin/actors/reload` で再読み込みできます。
**リストから外されたアカウントのセッションは即座に失効します。**

#### トークン方式との関係

`AUTH_MODE=oauth` にすると、トークンに関する経路はすべて無効になります。

- `Authorization: Bearer` による認証
- トークンによるログイン (`POST /api/admin/session`)
- **トークン未設定時の loopback 例外**

3 つ目が重要です。loopback 例外はトークン方式の利便機能であり、`AUTH_MODE=oauth` では
localhost からでも認証なしに管理 API を操作できません。`ADMIN_TOKEN` も不要になります。

監視スクリプトなどで Bearer 認証を併用したい場合は `AUTH_MODE=both` にし、
`ADMIN_TOKEN` を設定してください。

#### 秘密鍵の管理は不要

本人確認にしか OAuth を使わないため、公開クライアント
(`token_endpoint_auth_method: none`) として構成しています。鍵の生成・保管・ローテーションを
運用に持ち込みません。クライアントメタデータは `GET /client-metadata.json` で自動配信されます。

### 認証の仕組み (セッション)

管理画面は**トークンをブラウザに保存しません。**

1. ログイン時に一度だけトークンを送る (`POST /api/admin/session`)
2. サーバーがセッションを発行し、**HttpOnly Cookie** で ID を返す
3. 以降のリクエストは Cookie で認証する

トークンは JavaScript から読めない場所に置かれ、`localStorage` にも残りません。

| 保護 | 内容 |
| --- | --- |
| セッション有効期限 | `ADMIN_SESSION_TTL_HOURS` (既定 12 時間) で自動失効 |
| 個別ログアウト | `DELETE /api/admin/session` |
| **全セッション失効** | 管理画面の「全セッション失効」ボタン。トークン漏洩時の緊急手段 |
| CSRF 対策 | `SameSite=Strict` + 状態変更操作に `X-Requested-With` ヘッダを要求 |
| Secure 属性 | HTTPS でアクセスされた場合に自動付与 |
| 総当たり対策 | 同一 IP から 5 分間に 10 回失敗で 429。`TRUST_PROXY` の設定が前提 |
| トークン強度 | `TRUST_PROXY=true` かつ 24 文字未満なら**起動を拒否** |
| 監査ログ | 誰がいつ何をしたかを記録 (`GET /api/admin/audit`、直近 200 件) |

`Authorization: Bearer <ADMIN_TOKEN>` も引き続き使えます。監視スクリプトなど、
ブラウザを介さない用途向けです。

### さらに強い認証が要る場合

本システムの認証は**共有トークン 1 個**が根拠です。誰がログインしたかを個人単位で
区別できず、特定の人だけを締め出すこともできません。

より強い認証が必要なら、**リバースプロキシの層で認証をかけることを推奨します。**
アプリ側の変更が不要で、2 要素認証や SSO をそのまま使えます。

| 手段 | 備考 |
| --- | --- |
| Cloudflare Access | 設定のみ。メール OTP / SSO / デバイス制限 |
| Authelia、oauth2-proxy | 自前で運用する場合 |
| クライアント証明書 (mTLS) | 運営端末が固定なら堅い |
| IP 制限 | 運営拠点に固定 IP があるなら併用する |

`/admin` と `/api/admin` にだけ適用すれば、会場モニター (`/wall`) は誰でも開けます。

将来的には AT Protocol の OAuth によるログインに移行し、
個人単位の識別・権限・失効を扱えるようにする計画です
([docs/roadmap.md](./roadmap.md) のフェーズ 3)。

---

## 1. Docker (Compose / 単体)

コンテナでの構成・永続化・更新手順は [docker.md](./docker.md) にまとめています。
公開時に必ず必要な設定は次の 2 つです。

```dotenv
ADMIN_TOKEN=<openssl rand -hex 32 の出力>
WALL_DOMAIN=wall.example.com   # compose.yaml が参照する公開ホスト名
```

`TRUST_PROXY=true` は `compose.yaml` 側で設定済みです。

```bash
cp .env.example .env    # 上の 2 つを設定する
docker compose up -d
```

| URL | 用途 |
| --- | --- |
| `https://wall.example.com/wall` | 会場モニター |
| `https://wall.example.com/admin` | 管理画面 |
| `https://wall.example.com/api/health` | ヘルスチェック |

`MULTI_TENANT=true` や画面モードの画像を使う場合は、`/app/data` にボリュームを
当てる必要があります (`compose.yaml` では設定済み)。詳細は [docker.md](./docker.md)。

---

## 2. LXC / 通常の Linux ホスト (systemd)

コンテナ化せず、アプリケーションとして直接動かす構成です。

### 手順

```bash
# LXC コンテナ内で実行
apt update && apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
corepack enable

git clone <このリポジトリ> /opt/bsky-live-wall
cd /opt/bsky-live-wall
pnpm install --frozen-lockfile
pnpm build

cp .env.example .env
# .env を編集 (ADMIN_TOKEN 必須、プロキシ配下なら TRUST_PROXY=true)

useradd --system --no-create-home --shell /usr/sbin/nologin bskywall
chown -R bskywall:bskywall /opt/bsky-live-wall

cp deploy/bsky-live-wall.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bsky-live-wall
systemctl status bsky-live-wall
journalctl -u bsky-live-wall -f
```

`deploy/bsky-live-wall.service` は権限を最小化した定義になっています
(`ProtectSystem=strict`、`ReadOnlyPaths`、`NoNewPrivileges` 等)。
状態はすべてメモリ上にあり書き込み先がないため、読み取り専用で動作します。

### ビルド済みの成果物を置く場合

GitHub Actions の `build` ワークフローが、実行に必要なものだけを固めた
`bsky-live-wall-<sha>.tar.gz` を作ります (成果物、タグを打った場合はリリースにも添付)。
ビルドの道具を置きたくない LXC ではこちらを使います。

```bash
# 取得して展開 (gh CLI を使う例。リリースからダウンロードしてもよい)
gh run download -n bsky-live-wall-<sha> -D /tmp
tar -xzf /tmp/bsky-live-wall-<sha>.tar.gz -C /opt
ln -sfn /opt/bsky-live-wall-<sha> /opt/bsky-live-wall

cd /opt/bsky-live-wall
corepack enable
# 依存は実行環境で入れる (Node と libc に合わせて解決させるため)
pnpm install --prod --frozen-lockfile

cp .env.example .env
# .env を編集してから systemd で起動する (上と同じ)
node dist/index.js
```

中身は `dist/` (サーバー)、`public/` (会場モニターとビルド済みの管理画面)、
`package.json` / `pnpm-lock.yaml` / `.env.example` です。ソースと開発依存は含みません。
更新はシンボリックリンクの張り替えで行えます。

### コンテナイメージを使う場合

`docker` ワークフローが `ghcr.io/<owner>/bsky-live-wall` へ push します。
`main` は `latest`、タグ `v1.2.3` は `1.2.3` / `1.2` / `1` として配られます。

```bash
docker pull ghcr.io/<owner>/bsky-live-wall:latest
```

### LXC コンテナ側の注意

- **非特権コンテナで問題ありません。** 特権は不要です。
- 送信方向のインターネット接続が必要です (下記 5 章)。
- メモリは 512MB で足ります。`BUFFER_SIZE` を大きくする場合は増やしてください。

---

## 3. Cloudflare Tunnel で公開する (Proxmox LXC など)

アプリを LXC / VM の中で動かし、公開は別ホストの `cloudflared` に任せる構成です。
グローバル IP もポート開放も要らず、TLS と証明書は Cloudflare 側で終わります。

```
[インターネット] --https--> [Cloudflare] --tunnel--> [Proxmox ホスト: cloudflared]
                                                            |  http
                                                            v
                                                   [LXC: bsky-live-wall :3000]
```

### アプリ側 (LXC)

`.env` の要点は次の 2 つです。

```dotenv
# cloudflared から届くようにする (loopback だけだと親ホストから叩けない)
HOST=0.0.0.0
# 前段にプロキシが居るので必須。実クライアント IP は X-Forwarded-For で判定する
TRUST_PROXY=true
# TRUST_PROXY=true では必須。未設定だと起動しない
ADMIN_TOKEN=<openssl rand -hex 32 の出力>
```

Docker で動かす場合は、アプリの `HOST` に加えて**ホスト側の公開アドレス**も
変える必要があります。`.env` に `BIND_ADDR=0.0.0.0` を足してください
(既定の `127.0.0.1` は、そのホストの中からしか届きません)。

```bash
docker compose up -d --force-recreate app
docker compose port app 3000     # 0.0.0.0:3000 と出れば正しい
```

Node で直接動かす場合 (systemd) は `HOST` の既定が `0.0.0.0` なので、
そのままで親ホストから届きます。

**`HOST=0.0.0.0` にしたぶんは、ファイアウォールで絞ってください。**
LXC へ入れるのは親ホスト (cloudflared) だけで十分です。

```bash
# 例: Proxmox ホストが 10.0.0.1 の場合
ufw allow from 10.0.0.1 to any port 3000 proto tcp
ufw deny 3000
```

### cloudflared 側 (Proxmox ホスト)

```yaml
# /etc/cloudflared/config.yml
tunnel: <トンネル ID>
credentials-file: /etc/cloudflared/<トンネル ID>.json

ingress:
  - hostname: wall.example.com
    service: http://10.0.0.50:3000   # LXC の IP
    originRequest:
      # SSE は長時間つながり続ける。既定 (30s) だと切れてしまう
      connectTimeout: 30s
      # チャンク転送を無効にしない。無効にすると SSE が届かない
      disableChunkedEncoding: false
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <トンネル ID> wall.example.com
systemctl restart cloudflared
```

### SSE (会場モニターへの配信) について

- アプリは 15 秒ごとに ping を送るため、Cloudflare のアイドルタイムアウト
  (約 100 秒) には掛かりません
- レスポンスには `Cache-Control: no-cache, no-transform` と
  `X-Accel-Buffering: no` を付けています。Cloudflare 側で
  `/api/stream` を **キャッシュしない**ままにしてください
  (既定でキャッシュされませんが、キャッシュルールを足すときは除外する)
- Rocket Loader や Auto Minify のような、応答を書き換える機能は
  会場モニターに対して有効にしないでください

### 管理画面だけ Cloudflare Access で守る

会場モニター (`/wall`, `/e/*/wall/*`) は来場者が開くため**公開のまま**にし、
管理画面だけを保護します。

| パス | 扱い |
| --- | --- |
| `/admin`, `/api/admin/*` | Cloudflare Access のポリシーを適用する |
| `/wall`, `/e/*/wall/*`, `/api/stream`, `/assets/*` | 公開のまま |

Access を全体に掛けると来場者が会場モニターを開けなくなります。`/api/stream`
にも掛けないでください (モニターが繋がりません)。

### 確認

```bash
# 親ホストから LXC のアプリへ届くこと
curl -s http://10.0.0.50:3000/api/health

# 公開 URL から届くこと
curl -s https://wall.example.com/api/health

# SSE が流れ続けること (ping が 15 秒ごとに出る)
curl -N https://wall.example.com/api/stream | head -20
```

---

## 4. リバースプロキシの設定 (最重要)

**SSE のバッファリングを無効化しないと、投稿が届かない、あるいは数十秒遅れて
まとめて届くという症状になります。**

設定例を用意しています。

| ファイル | 用途 |
| --- | --- |
| `deploy/Caddyfile` | Caddy (compose 構成で使用) |
| `deploy/nginx.conf` | nginx |

### 要点

| 設定 | 値 | 理由 |
| --- | --- | --- |
| バッファリング | 無効 (`proxy_buffering off` / `flush_interval -1`) | SSE が届かなくなる |
| 圧縮 | `/api/stream` では無効 | 同上 |
| 読み取りタイムアウト | 24 時間以上 または 無制限 | ストリームは張りっぱなしになる |
| HTTP バージョン | 1.1 | |
| `X-Forwarded-For` | 転送する | `TRUST_PROXY` が実 IP を判定するため |

アプリ側は `X-Accel-Buffering: no` を返しているため、nginx はこれだけでも
バッファリングを止めますが、設定でも明示しておくことを推奨します。

### 管理画面の追加保護

運営拠点に固定 IP があるなら、プロキシ側で `/admin` と `/api/admin` を IP 制限すると
さらに堅くなります。設定例は `deploy/Caddyfile` と `deploy/nginx.conf` に
コメントアウトで入れてあります。

---

## 5. ネットワーク要件

### サーバーからの送信

| 宛先 | 用途 |
| --- | --- |
| `wss://jetstream*.bsky.network:443` | 投稿の受信 |
| `https://public.api.bsky.app:443` | プロフィール取得 |

### 会場・視聴者からの受信

| 宛先 | 用途 |
| --- | --- |
| サーバーの 443 | 画面表示と管理画面 |
| `https://cdn.bsky.app:443` | 画像 (**ブラウザから直接取得する**) |

会場のネットワークが `cdn.bsky.app` を遮断していると、投稿は表示されますが画像だけが
出ません。`SHOW_IMAGES=false` にすれば画像枠ごと消せます。

---

## 6. 運用

### 状態の永続化

単一テナント運用では、投稿・統計・ブロック・非表示はすべてメモリ上にあります。
**再起動するとすべて失われます。** バックアップ対象はありません。

イベント中に再起動が必要になった場合、`STARTUP_BACKFILL_MINUTES` の分だけ
過去に遡って自動で復元されるため、画面は数十秒で元の状態に近づきます。
ただし**ブロックと非表示の設定は失われます。** 恒久的に除外したい相手は
`.env` の `BLOCK_ACTORS` に書いておいてください。

### ログ

| 構成 | 確認方法 |
| --- | --- |
| Docker Compose | `docker compose logs -f app` |
| Docker 単体 | `docker logs -f bsky-live-wall` |
| systemd | `journalctl -u bsky-live-wall -f` |

compose 構成ではログを 10MB × 3 世代でローテーションしています。

### マルチテナント運用時のバックアップ

`MULTI_TENANT=true` では `DATA_FILE` (既定 `./data/wall.db`) にテナント設定が
保存されます。**これが唯一のバックアップ対象です。**

コンテナで動かす場合、このパスをボリュームにしてください。`compose.yaml` の
`read_only: true` とも競合するため、`data` を書き込み可能なボリュームとして
明示的に割り当てる必要があります。

```yaml
    volumes:
      - wall_data:/app/data
    environment:
      DATA_FILE: /app/data/wall.db
```

SQLite は WAL モードで動くため、`wall.db` に加えて `wall.db-wal` と `wall.db-shm` が
できます。バックアップはプロセス停止中に 3 つまとめて取るのが確実です。

### 監視

`GET /api/health` が `{"ok":true}` を返し、`jetstream.connected` が `true` であることを
確認してください。`connected` が `false` のまま続く場合は、送信方向の WebSocket が
遮断されている可能性があります。

---

## 7. トラブルシューティング

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| 起動直後に終了し「TRUST_PROXY=true では ADMIN_TOKEN が必須です」 | 意図した保護動作 | `ADMIN_TOKEN` を設定する |
| 投稿が届かない / 数十秒遅れてまとめて届く | プロキシが SSE をバッファしている | 4 章の設定を見直す |
| 管理画面で 401 が続く | トークン不一致 | `.env` の値とブラウザに保存された値を確認する |
| 管理画面で 429 | 認証失敗の総当たり対策 | 5 分待つ。`TRUST_PROXY` の設定漏れも疑う |
| `jetstream.connected` が `false` のまま | 送信方向の WebSocket が遮断されている | ファイアウォールで 443 の WebSocket を許可する |
| ページは開くが画像だけ出ない | 視聴者側から `cdn.bsky.app` へ到達できない | `SHOW_IMAGES=false` にする |
| コンテナが `unhealthy` | アプリが応答していない | `docker logs` を確認する |

---

## 8. ホスティング先の検討

### Cloudflare Workers / Durable Objects — 推奨しない

永続接続そのものは可能ですが、次の理由で本システムには合いません
(いずれも Cloudflare の公式ドキュメントで確認)。

- Durable Object の**外向き WebSocket が退避を防ぐのは 1 接続あたり最大 15 分**。
  以後は通常の退避規則 (70〜140 秒の無通信で退避) に戻る
- **外向き WebSocket はハイバネーションできない** (受信側 WebSocket 専用の機能)
- 生かし続けるにはアラーム等で常時イベントを起こす必要があり、その間ずっと duration 課金が発生する
- `ws` / `node:sqlite` / Fastify / `@fastify/static` をすべて Workers の API へ書き直す必要がある

### Cloudflare Containers — 可能だが制約を理解して使うこと

現在の Docker イメージがほぼそのまま動きます。ただし:

- **インスタンスの稼働時間は保証されない。** 公式ドキュメントに
  「Cloudflare does not guarantee that any container instance will run for any set period of time」
  と明記されており、ホスト再起動が不定期に発生する
- 停止時は SIGTERM → 最大 15 分待機 → SIGKILL
- **コンテナのローカルディスクは永続ではない。** `DATA_FILE` に SQLite を置く構成は
  そのままでは成立せず、Durable Objects の SQLite ストレージか D1 への差し替えが必要
  (`TenantStore` インターフェースの別実装として追加できる形にしてある)

再起動でメモリ上の状態 (ブロック・非表示・表示中の投稿) が失われる点が、
イベント中の運用では効きます。投稿はバックフィルで戻りますが、荒らし対策は戻りません。

### 推奨: 常時稼働の VM + Cloudflare Tunnel

ライブイベント中に落ちてはいけない性質上、常時稼働のサーバー
(VPS / Fly.io / Railway / 自前の LXC など) が素直です。

Cloudflare は前段の TLS・DNS・DDoS 対策として使い、**Cloudflare Tunnel** で
ポートを開けずに公開する構成が本システムによく合います。会場や自宅のサーバーを
そのまま出せます。
