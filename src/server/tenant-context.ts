/**
 * リクエストへテナント (TenantRuntime) を紐付けるための型拡張とヘルパ。
 *
 * テナント解決は `createServer` が組み立てる 2 種類の `onRequest` フックで行い
 * (ルート直下 / `/e/:eventId` 配下)、解決できた場合だけ `request.tenant` に
 * 積む。解決できなければフック自身が 404 を返して以降のハンドラへ進まない
 * ため、ルートハンドラ側では「必ず積まれている」前提で `getTenant()` を使える。
 */
import type { FastifyRequest } from 'fastify';
import type { TenantRuntime } from '../shared/ingest-contracts.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantRuntime;
  }
}

/**
 * テナント解決フックを通過した後のハンドラで使う。
 * フックが通っていれば必ず設定されているはずなので、無ければ実装ミスとして例外にする。
 */
export function getTenant(request: FastifyRequest): TenantRuntime {
  const tenant = request.tenant;
  if (!tenant) {
    throw new Error('テナント解決フックの後でのみ呼び出せるはずの経路で request.tenant が未設定です');
  }
  return tenant;
}
