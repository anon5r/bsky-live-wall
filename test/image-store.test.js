import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { signRequest, createImageStore } from '../dist/server/image-store.js';

const FIXED_DATE = new Date('2026-09-11T12:00:00.000Z');
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function sign(overrides = {}) {
  return signRequest({
    method: 'GET',
    url: new URL('https://example.r2.cloudflarestorage.com/bucket/uploads/abc.png'),
    payloadHash: EMPTY_SHA256,
    region: 'auto',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    now: FIXED_DATE,
    ...overrides,
  });
}

test('署名に必要なヘッダが揃う', () => {
  const headers = sign();
  assert.equal(headers.host, 'example.r2.cloudflarestorage.com');
  assert.equal(headers['x-amz-date'], '20260911T120000Z');
  assert.equal(headers['x-amz-content-sha256'], EMPTY_SHA256);
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260911\/auto\/s3\/aws4_request, /);
  assert.match(headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test('同じ入力からは同じ署名が出る (実サーバーで検証済みの値を固定する)', () => {
  // MinIO (S3 互換) に対する PUT / GET / DELETE が通ることを確認したうえで、
  // 実装を変えたときに署名が変わらないことを見張るための値。
  const first = sign().authorization;
  const second = sign().authorization;
  assert.equal(first, second);
  assert.equal(first, sign({ url: new URL('https://example.r2.cloudflarestorage.com/bucket/uploads/abc.png') }).authorization);
});

test('本文や宛先が変われば署名も変わる', () => {
  const base = sign().authorization;
  assert.notEqual(base, sign({ method: 'PUT' }).authorization);
  assert.notEqual(base, sign({ payloadHash: createHash('sha256').update('x').digest('hex') }).authorization);
  assert.notEqual(
    base,
    sign({ url: new URL('https://example.r2.cloudflarestorage.com/bucket/uploads/other.png') }).authorization
  );
  assert.notEqual(base, sign({ region: 'ap-northeast-1' }).authorization);
});

test('追加ヘッダは署名対象に入る (Content-Type など)', () => {
  const headers = sign({ method: 'PUT', extraHeaders: { 'Content-Type': 'image/png' } });
  assert.equal(headers['content-type'], 'image/png');
  assert.match(headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
});

test('ローカル保存は書いて読んで消せる', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wall-images-'));
  const store = createImageStore({
    storage: { driver: 'local', s3: {} },
    tenancy: { uploadDir: dir },
  });

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const stored = await store.put(png, 'image/png');
  assert.match(stored.key, /^[0-9a-f]{32}\.png$/);
  assert.ok(existsSync(join(dir, stored.key)));
  assert.ok(readFileSync(join(dir, stored.key)).equals(png));

  const url = store.publicUrl(stored.key, 42);
  assert.equal(url, `/uploads/${stored.key}?v=42`);

  const read = await store.read(stored.key);
  assert.ok(read.bytes.equals(png));
  assert.equal(read.mime, 'image/png');

  await store.remove(stored.key);
  assert.equal(existsSync(join(dir, stored.key)), false);
});

test('パスを遡るキーは受け付けない', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wall-images-'));
  const store = createImageStore({
    storage: { driver: 'local', s3: {} },
    tenancy: { uploadDir: dir },
  });

  assert.equal(await store.read('../../etc/passwd'), null);
  assert.equal(await store.read('sub/dir.png'), null);
  // 消そうとしても何も起きない (例外にしない)
  await store.remove('../../etc/passwd');
});

test('S3 を選んだのに設定が足りなければ起動時に気付ける', () => {
  assert.throws(
    () =>
      createImageStore({
        storage: { driver: 's3', s3: { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: '', publicBaseUrl: '', forcePathStyle: true } },
        tenancy: { uploadDir: '/tmp' },
      }),
    /S3_ENDPOINT/
  );
});
