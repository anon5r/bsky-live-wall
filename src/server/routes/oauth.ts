/**
 * AT Protocol OAuth によるログイン。
 *
 * 経路:
 *   1. 利用者がハンドルを入力 -> POST /api/auth/login で認可 URL を得る
 *   2. 利用者の PDS で認可し、GET /api/auth/callback へ戻る
 *   3. DID を許可リストと照合し、通れば管理セッション Cookie を発行する
 *
 * OAuth は本人確認までしか担わない。管理してよいかは許可リストで決める。
 */
import type { FastifyInstance } from 'fastify';
import type { NodeOAuthClient } from '@atproto/oauth-client-node';
import type { AppConfig } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { AdminSessionStore, SESSION_COOKIE } from '../admin-session.js';
import {
  CALLBACK_PATH,
  CLIENT_METADATA_PATH,
  buildClientMetadata,
  createOAuthClient,
  resolveAllowedActors,
  type AllowedActor,
} from '../oauth/client.js';

const log = createLogger('oauth-routes');

/** ハンドルの形式を軽く検証する。厳密な解決はライブラリに任せる。 */
function looksLikeActor(input: string): boolean {
  if (input.startsWith('did:')) return input.length <= 256;
  return /^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i.test(input) && input.includes('.');
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  sessions: AdminSessionStore
): Promise<void> {
  const enabled = config.admin.authMode === 'oauth' || config.admin.authMode === 'both';

  // 認証方式は管理画面の初期表示に必要なため、無効でも問い合わせに答える。
  app.get('/api/auth/config', async (_request, reply) =>
    reply.send({
      oauth: enabled,
      token: config.admin.authMode === 'token' || config.admin.authMode === 'both',
    })
  );

  if (!enabled) return;

  let client: NodeOAuthClient;
  try {
    client = createOAuthClient(config);
  } catch (err) {
    log.error('OAuth クライアントを構築できませんでした', err);
    throw err;
  }

  // 許可リストは起動時に DID へ解決する。ハンドルは変更され得るため。
  let allowed: Map<string, AllowedActor> = await resolveAllowedActors(config);
  log.info(`管理を許可するアカウント: ${allowed.size} 件`, {
    actors: [...allowed.values()].map((a) => a.handle),
  });

  app.get(CLIENT_METADATA_PATH, async (_request, reply) =>
    reply.type('application/json').send(buildClientMetadata(config))
  );

  app.post<{ Body: { handle?: unknown } }>('/api/auth/login', async (request, reply) => {
    const { handle } = request.body ?? {};
    if (typeof handle !== 'string' || !looksLikeActor(handle.trim().replace(/^@/, ''))) {
      return reply.code(400).send({ error: 'bad_request', message: 'ハンドルの形式が不正です' });
    }
    try {
      const url = await client.authorize(handle.trim().replace(/^@/, ''));
      return reply.send({ url: url.toString() });
    } catch (err) {
      log.warn('認可 URL の生成に失敗しました', err);
      return reply
        .code(400)
        .send({ error: 'authorize_failed', message: 'アカウントを解決できませんでした' });
    }
  });

  app.get(CALLBACK_PATH, async (request, reply) => {
    const params = new URLSearchParams(request.url.split('?')[1] ?? '');
    try {
      const { session } = await client.callback(params);
      const did = session.did;

      const actor = allowed.get(did);
      if (!actor) {
        log.warn('許可リストにないアカウントのログインを拒否', { did });
        // 認可自体は成立しているため、こちら側のセッションは作らずに破棄する。
        await client.revoke(did).catch(() => undefined);
        return reply.redirect('/admin?error=not_allowed');
      }

      const adminSession = sessions.create(
        request.ip,
        String(request.headers['user-agent'] ?? ''),
        { did, handle: actor.handle }
      );
      const secure = request.protocol === 'https';
      reply.header(
        'Set-Cookie',
        `${SESSION_COOKIE}=${adminSession.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessions.ttlSeconds}` +
          (secure ? '; Secure' : '')
      );
      log.info('OAuth ログイン', { handle: actor.handle, did, ip: request.ip });
      return reply.redirect('/admin');
    } catch (err) {
      log.warn('OAuth コールバックの処理に失敗しました', err);
      return reply.redirect('/admin?error=oauth_failed');
    }
  });

  // 許可リストはイベント中に編集され得る。管理画面から再読み込みできるようにする。
  app.post('/api/admin/actors/reload', async (_request, reply) => {
    const previous = new Set(allowed.keys());
    allowed = await resolveAllowedActors(config);
    // 外されたアカウントのセッションは即座に失効させる。
    let revoked = 0;
    for (const did of previous) {
      if (!allowed.has(did)) revoked += sessions.revokeByDid(did);
    }
    return reply.send({ allowed: [...allowed.values()], revoked });
  });

  app.get('/api/admin/actors', async (_request, reply) =>
    reply.send({ allowed: [...allowed.values()] })
  );
}
