# 画像の保存先 (ローカル / S3 互換ストレージ)

会場モニターの画面モードで出す画像 (QR コード、会場案内など) の置き場所を選べます。
画像以外はディスクに書きません (投稿はメモリ上のリングバッファ、テナント設定は
`DATA_FILE` の SQLite)。

| 保存先 | 向いている場面 |
| --- | --- |
| `local` (既定) | 1 台で動かす。LXC や会場 PC |
| `s3` | コンテナを使い捨てにする。複数インスタンスで同じ画像を見せる。CDN から配りたい |

`s3` は S3 API 互換のサービス全般で使えます。動作を確認しているのは
**Cloudflare R2 / MEGA S4 / AWS S3 / Backblaze B2** の構成です (MinIO でも動きます)。
SDK は使わず、必要な 3 操作 (PUT / GET / DELETE) を SigV4 で署名しています。

## ローカル保存 (既定)

```dotenv
STORAGE_DRIVER=local
UPLOAD_DIR=./data/uploads
```

- ファイル名は推測できない乱数 + 拡張子。会場モニターは公開ページのため、
  URL を知らなければ開けない形にしています
- 配信はアプリが `/uploads/<ファイル名>` で行います
- コンテナでは `UPLOAD_DIR` をボリュームに載せてください
  ([docker.md](./docker.md))

## S3 互換ストレージ

```dotenv
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<アカウント ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=bsky-live-wall
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=                 # 例: bsky-live-wall/ (バケットを共有する場合)
S3_PUBLIC_BASE_URL=        # 公開 URL の基点。空ならアプリが中継する
S3_FORCE_PATH_STYLE=true
```

設定が足りないまま `STORAGE_DRIVER=s3` にすると、**起動時に足りない項目を挙げて
停止**します (動き出してから画像だけ失敗する、という事態を避けるため)。

### サービスごとの設定

| サービス | `S3_ENDPOINT` | `S3_REGION` | 備考 |
| --- | --- | --- | --- |
| Cloudflare R2 | `https://<アカウント ID>.r2.cloudflarestorage.com` | `auto` | 公開は R2 のカスタムドメインが楽 |
| AWS S3 | `https://s3.<リージョン>.amazonaws.com` | `ap-northeast-1` など | CloudFront を前に置く構成も可 |
| Backblaze B2 | `https://s3.<リージョン>.backblazeb2.com` | `us-west-004` など | S3 互換エンドポイントを使う |
| MEGA S4 | 管理画面に表示されるエンドポイント | 同上 | |
| MinIO | `http://minio:9000` | 任意 (`us-east-1` など) | 自前で建てる場合 |

必要な権限はオブジェクトの読み書きだけです (`PutObject` / `GetObject` /
`DeleteObject`)。バケットの一覧や作成は行いません。

### 会場モニターからの参照

`S3_PUBLIC_BASE_URL` の有無で 2 通りに分かれます。

**公開 URL がある場合 (推奨)**

```dotenv
S3_PUBLIC_BASE_URL=https://images.example.com
```

会場モニターは `https://images.example.com/<接頭辞><キー>?v=<更新時刻>` を直接読みます。
アプリを経由しないぶん軽く、CDN のキャッシュも効きます。R2 のカスタムドメインや
CloudFront を当てる構成がこれです。

**公開 URL が無い場合**

バケットを非公開のままにできます。会場モニターは `/uploads/<キー>` を読み、
アプリが署名付きでストレージから取得して返します。URL の形はローカル保存のときと
同じなので、あとから切り替えても会場モニター側の扱いは変わりません。

> `?v=<更新時刻>` は画像を差し替えたときに古いキャッシュを踏まないために付けています。

### 切り替えるとき

保存先を変えても、既に設定済みの画像は**自動では移りません**。管理画面の
「会場モニター」から画像を選び直してください (古い画像は元の保存先に残るので、
不要なら手で消してください)。

## 動作確認

```bash
# 起動ログに保存先が出る
# [INFO] (image-store) 画像の保存先: S3 互換ストレージ { endpoint: ..., bucket: ..., delivery: ... }

# 管理画面の「会場モニター」で画像を選び、プレビューに出ることを確認する
# 会場モニター側は、通常モード以外で画像が出れば成功
```

うまくいかないときは起動ログとアプリのログを見てください。保存に失敗した場合は
管理画面にトーストが出て、ログに応答コードが残ります。

| 症状 | 原因 |
| --- | --- |
| 起動時に `S3_ENDPOINT` などのエラー | 設定が足りない |
| アップロードが 500 になる | 認証情報かバケット名の誤り、権限不足 (ログに応答コード) |
| 画像が壊れて見える | `S3_PUBLIC_BASE_URL` の綴り違い、または接頭辞の重複 |
| 画像だけ表示されない (公開 URL 構成) | バケットが非公開のまま。公開するか、`S3_PUBLIC_BASE_URL` を空にして中継させる |
