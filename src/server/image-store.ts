/**
 * 会場モニターに出す画像 (QR コードや案内) の保存先。
 *
 * ローカルのディスクと、S3 互換ストレージ (Cloudflare R2 / MEGA S4 / AWS S3 /
 * Backblaze B2 など) を同じ形で扱う。どれも S3 API 互換なので、署名さえ作れば
 * 1 つのドライバで足りる。SDK を入れずに SigV4 を自前で組み立てているのは、
 * 使う操作が PUT / GET / DELETE の 3 つだけで、依存とイメージサイズを増やす
 * 割に合わないため。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('image-store');

/** 受け付ける画像と、保存時に付ける拡張子。 */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export interface StoredImage {
  /** 保存先の中での識別子。ローカルではファイル名、S3 ではキー (接頭辞なし) */
  key: string;
  mime: string;
}

export interface ImageStore {
  readonly kind: 'local' | 's3';
  /**
   * 画像を保存して識別子を返す。
   * 会場モニターは公開ページなので、ファイル名は推測できない乱数にする。
   */
  put(bytes: Buffer, mime: string): Promise<StoredImage>;
  /** 消す。存在しなくてもエラーにしない (表示には影響しないため)。 */
  remove(key: string): Promise<void>;
  /**
   * 会場モニターが参照する URL。
   * null を返した場合は、アプリが `/uploads/<key>` で中継する。
   */
  publicUrl(key: string, version: number): string | null;
  /** アプリが中継するときに読む。中継しない構成では undefined。 */
  read?(key: string): Promise<{ bytes: Buffer; mime: string } | null>;
}

/** 保存名を作る。拡張子は MIME から決める (入力のファイル名は信用しない)。 */
function newKey(mime: string): string {
  const ext = IMAGE_EXTENSIONS[mime] ?? 'bin';
  return `${randomBytes(16).toString('hex')}.${ext}`;
}

// ---------------------------------------------------------------------------
// ローカル
// ---------------------------------------------------------------------------

class LocalImageStore implements ImageStore {
  readonly kind = 'local' as const;

  constructor(private readonly dir: string) {}

  async put(bytes: Buffer, mime: string): Promise<StoredImage> {
    const key = newKey(mime);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, key), bytes);
    return { key, mime };
  }

  async remove(key: string): Promise<void> {
    if (!isSafeKey(key)) return;
    try {
      await rm(join(this.dir, key), { force: true });
    } catch {
      // 消せなくても表示には影響しない
    }
  }

  publicUrl(key: string, version: number): string | null {
    // 配信は fastify-static (/uploads/) が行う。
    return `/uploads/${encodeURIComponent(key)}?v=${version}`;
  }

  async read(key: string): Promise<{ bytes: Buffer; mime: string } | null> {
    if (!isSafeKey(key)) return null;
    try {
      const bytes = await readFile(join(this.dir, key));
      return { bytes, mime: mimeFromKey(key) };
    } catch {
      return null;
    }
  }
}

/** パス区切りや親ディレクトリを含むキーは受け付けない。 */
function isSafeKey(key: string): boolean {
  return key !== '' && !key.includes('/') && !key.includes('\\') && !key.includes('..');
}

function mimeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  for (const [mime, e] of Object.entries(IMAGE_EXTENSIONS)) {
    if (e === ext) return mime;
  }
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// S3 互換 (R2 / MEGA S4 / AWS S3 / B2)
// ---------------------------------------------------------------------------

type S3Config = AppConfig['storage']['s3'];

class S3ImageStore implements ImageStore {
  readonly kind = 's3' as const;

  constructor(private readonly config: S3Config) {}

  async put(bytes: Buffer, mime: string): Promise<StoredImage> {
    const key = newKey(mime);
    const res = await this.request('PUT', key, bytes, { 'content-type': mime });
    if (!res.ok) {
      throw new Error(`S3 への保存に失敗しました (${res.status}): ${await safeText(res)}`);
    }
    return { key, mime };
  }

  async remove(key: string): Promise<void> {
    if (!isSafeKey(key)) return;
    try {
      const res = await this.request('DELETE', key);
      // 既に無い場合の 404 は成功扱いでよい。
      if (!res.ok && res.status !== 404) {
        log.warn(`S3 の画像を消せませんでした (${res.status})`);
      }
    } catch (err) {
      log.warn('S3 の画像を消せませんでした', err);
    }
  }

  publicUrl(key: string, version: number): string | null {
    if (!this.config.publicBaseUrl) return null;
    return `${this.config.publicBaseUrl}/${this.objectPath(key)}?v=${version}`;
  }

  async read(key: string): Promise<{ bytes: Buffer; mime: string } | null> {
    if (!isSafeKey(key)) return null;
    try {
      const res = await this.request('GET', key);
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, mime: res.headers.get('content-type') ?? mimeFromKey(key) };
    } catch (err) {
      log.warn('S3 から画像を読めませんでした', err);
      return null;
    }
  }

  /** 接頭辞を付けたオブジェクトキー。 */
  private objectPath(key: string): string {
    return `${this.config.prefix}${key}`;
  }

  /** 署名付きのリクエストを 1 本投げる。 */
  private async request(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const { endpoint, bucket, forcePathStyle } = this.config;
    const base = new URL(endpoint);
    const objectPath = this.objectPath(key);

    // パススタイル (既定): https://<endpoint>/<bucket>/<key>
    // 仮想ホスト:          https://<bucket>.<endpoint>/<key>
    const url = new URL(endpoint);
    if (forcePathStyle) {
      url.pathname = `/${bucket}/${objectPath}`;
    } else {
      url.host = `${bucket}.${base.host}`;
      url.pathname = `/${objectPath}`;
    }

    const payloadHash = createHash('sha256')
      .update(body ?? Buffer.alloc(0))
      .digest('hex');

    const headers = signRequest({
      method,
      url,
      payloadHash,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      extraHeaders,
    });

    return fetch(url, { method, headers, body: body ?? undefined });
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

export interface SignInput {
  method: string;
  url: URL;
  /** 本文の SHA-256 (16 進)。本文なしでも空文字列のハッシュを渡す */
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  extraHeaders?: Record<string, string>;
  /** テスト用に時刻を固定するためのもの。省略時は現在時刻 */
  now?: Date;
  service?: string;
}

/**
 * SigV4 の署名済みヘッダを組み立てる。
 * https://docs.aws.amazon.com/ja_jp/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */
export function signRequest(input: SignInput): Record<string, string> {
  const service = input.service ?? 's3';
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260911T120000Z
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
    ...normalizeHeaderKeys(input.extraHeaders ?? {}),
  };

  // 署名対象はヘッダ名の昇順。値は前後の空白を落とす。
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n]?.trim() ?? ''}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    input.method,
    canonicalUri(input.url.pathname),
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  // 署名鍵は日付 → リージョン → サービス → 固定文字列の順に HMAC を重ねる。
  const kDate = hmac(Buffer.from('AWS4' + input.secretAccessKey, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const signingKey = hmac(kService, 'aws4_request');

  const signature = hmac(signingKey, stringToSign).toString('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function normalizeHeaderKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/**
 * パスは区切り文字を残したまま、セグメントごとに RFC 3986 で符号化する。
 * S3 では符号化済みのパスをそのまま署名対象にする。
 */
function canonicalUri(pathname: string): string {
  if (pathname === '') return '/';
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/');
}

function canonicalQuery(params: URLSearchParams): string {
  const entries: [string, string][] = [];
  params.forEach((value, name) => entries.push([name, value]));
  entries.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return entries.map(([n, v]) => `${encodeRfc3986(n)}=${encodeRfc3986(v)}`).join('&');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** 設定から保存先を作る。S3 の設定が足りない場合は例外を投げる (起動時に気付かせる)。 */
export function createImageStore(config: AppConfig): ImageStore {
  if (config.storage.driver !== 's3') {
    return new LocalImageStore(config.tenancy.uploadDir);
  }

  const s3 = config.storage.s3;
  const missing = (['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).filter(
    (key) => s3[key] === ''
  );
  if (missing.length > 0) {
    throw new Error(
      `STORAGE_DRIVER=s3 には次の設定が必要です: ${missing
        .map((k) => 'S3_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase())
        .join(', ')}`
    );
  }

  log.info('画像の保存先: S3 互換ストレージ', {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    // 直接配るか、アプリが中継するか。
    delivery: s3.publicBaseUrl ? s3.publicBaseUrl : '/uploads (アプリが中継)',
  });
  return new S3ImageStore(s3);
}
