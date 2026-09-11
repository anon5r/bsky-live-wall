/**
 * AT Protocol OAuth によるログイン。
 *
 * 経路:
 *   1. 利用者がハンドルを入力 -> POST /api/auth/login で認可 URL を得る
 *   2. 利用者の PDS で認可し、GET /api/auth/callback へ戻る
 *   3. DID を許可リストと照合し、通れば管理セッション Cookie を発行する
 *
 * OAuth は本人確認までしか担わない。管理してよいかは許可リストで決める。
 *
 * ここで登録するのはテナントに属さない経路のみ (`/api/auth/*`、
 * `/client-metadata.json`)。許可リストの一覧・再読み込み (`/api/admin/actors*`) は
 * テナントに属する API として `registerActorsRoutes` (下) が別に登録する
 * (この関数が返す `OAuthRuntime` を介して許可リストの状態を共有する)。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodeOAuthClient } from '@atproto/oauth-client-node';
import type { AppConfig } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { checkTenantPermission, isSystemAdmin } from '../permission.js';
import type { TenantRegistry } from '../../shared/ingest-contracts.js';
import { getTenant } from '../tenant-context.js';
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

/** 許可リストの状態を、テナントスコープの actors ルートと共有するための窓口。 */
export interface OAuthRuntime {
  listAllowed(): AllowedActor[];
  reloadActors(): Promise<{ allowed: AllowedActor[]; revoked: number }>;
}

/**
 * ログイン後に戻す経路として許すのは管理画面だけ。
 * `/admin` と `/e/<tenant>/admin` のみを通し、それ以外 (外部 URL や別経路への
 * 誘導) は既定の `/admin` に落とす。オープンリダイレクトを作らないため。
 */
const RETURN_TO_RE = /^\/(?:admin\/?|e\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}\/admin\/?)$/;

const DEFAULT_RETURN_TO = '/admin';

export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return DEFAULT_RETURN_TO;
  return RETURN_TO_RE.test(raw) ? raw : DEFAULT_RETURN_TO;
}

/** 戻り先にエラー種別を付ける。管理画面が読み取ってメッセージを出す。 */
function withError(returnTo: string, code: string): string {
  return `${returnTo}?error=${encodeURIComponent(code)}`;
}

/**
 * `.env` の許可リストに載っていなくても、管理画面から招待された人はログインできる。
 *
 * 招待の実体はテナントのメンバー表であり (管理画面の「メンバー」)、どのテナントで
 * 何ができるかは `checkTenantPermission` がリクエストごとに見る。ここを許可リスト
 * だけで閉じてしまうと、招待したモデレーターが入口で弾かれてしまう。
 * システム管理者 (`SYSTEM_ADMINS`) も同じ理由で通す。
 */
export function findInvitedActor(did: string, registry?: TenantRegistry): AllowedActor | undefined {
  const handle = findMemberHandle(did, registry);
  if (handle !== undefined) return { did, handle };
  // メンバー表に無くても、システム管理者は全テナントを管理できる立場なので通す。
  return isSystemAdmin(did) ? { did, handle: did } : undefined;
}

function findMemberHandle(did: string, registry?: TenantRegistry): string | undefined {
  if (!registry) return undefined;
  for (const tenant of registry.listForDid(did)) {
    const member = tenant.listMembers().find((m) => m.did === did);
    if (member) return member.handle || did;
  }
  return undefined;
}

/** ハンドルの形式を軽く検証する。厳密な解決はライブラリに任せる。 */
function looksLikeActor(input: string): boolean {
  if (input.startsWith('did:')) return input.length <= 256;
  return /^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i.test(input) && input.includes('.');
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  sessions: AdminSessionStore,
  registry?: TenantRegistry
): Promise<OAuthRuntime | undefined> {
  const enabled = config.admin.authMode === 'oauth' || config.admin.authMode === 'both';

  // 認証方式は管理画面の初期表示に必要なため、無効でも問い合わせに答える。
  app.get('/api/auth/config', async (_request, reply) =>
    reply.send({
      oauth: enabled,
      token: config.admin.authMode === 'token' || config.admin.authMode === 'both',
    })
  );

  if (!enabled) return undefined;

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

  app.post<{ Body: { handle?: unknown; returnTo?: unknown } }>(
    '/api/auth/login',
    async (request, reply) => {
      const { handle, returnTo } = request.body ?? {};
      if (typeof handle !== 'string' || !looksLikeActor(handle.trim().replace(/^@/, ''))) {
        return reply.code(400).send({ error: 'bad_request', message: 'ハンドルの形式が不正です' });
      }
      try {
        // 認可から戻ったときに元のテナントの管理画面へ帰れるよう、経路を state に載せる。
        const url = await client.authorize(handle.trim().replace(/^@/, ''), {
          state: safeReturnTo(returnTo),
        });
        return reply.send({ url: url.toString() });
      } catch (err) {
        log.warn('認可 URL の生成に失敗しました', err);
        return reply
          .code(400)
          .send({ error: 'authorize_failed', message: 'アカウントを解決できませんでした' });
      }
    }
  );

  app.get(CALLBACK_PATH, async (request, reply) => {
    const params = new URLSearchParams(request.url.split('?')[1] ?? '');
    // state には認可を始めた画面の経路が入っている (safeReturnTo で検証済み)。
    let returnTo = DEFAULT_RETURN_TO;
    try {
      const { session, state } = await client.callback(params);
      returnTo = safeReturnTo(state);
      const did = session.did;

      const actor = allowed.get(did) ?? findInvitedActor(did, registry);
      if (!actor) {
        log.warn('許可リストにないアカウントのログインを拒否', { did });
        // 認可自体は成立しているため、こちら側のセッションは作らずに破棄する。
        await client.revoke(did).catch(() => undefined);
        return reply.redirect(withError(returnTo, 'not_allowed'));
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
      return reply.redirect(returnTo);
    } catch (err) {
      log.warn('OAuth コールバックの処理に失敗しました', err);
      return reply.redirect(withError(returnTo, 'oauth_failed'));
    }
  });

  // 許可リストの一覧・再読み込みは `/api/admin/actors*` として別途テナント
  // スコープに登録する (`registerActorsRoutes`)。ここでは状態を共有するだけ。
  return {
    listAllowed: () => [...allowed.values()],
    reloadActors: async () => {
      const previous = new Set(allowed.keys());
      allowed = await resolveAllowedActors(config);
      // 外されたアカウントのセッションは即座に失効させる。
      let revoked = 0;
      for (const did of previous) {
        if (!allowed.has(did)) revoked += sessions.revokeByDid(did);
      }
      return { allowed: [...allowed.values()], revoked };
    },
  };
}

/**
 * `/api/admin/actors` (一覧) / `/api/admin/actors/reload` (再読み込み)。
 * テナントに属する管理 API として登録する (権限判定のため)。
 * `oauth` が無効、または OAuth 自体が無効な構成では登録しない
 * (呼び出し側が `runtime` が `undefined` かどうかで判断する)。
 *
 * 再読み込みは許可リストという「設定」を書き換える操作のため owner 限定。
 * 一覧の閲覧は運用上の確認によく使うため moderator でも可とする。
 */
export function registerActorsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  sessions: AdminSessionStore,
  runtime: OAuthRuntime
): void {
  app.get('/api/admin/actors', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = getTenant(request);
    const denial = checkTenantPermission(config, sessions, request, tenant, 'moderator');
    if (denial) return reply.code(denial.status).send(denial.body);
    return reply.send({ allowed: runtime.listAllowed() });
  });

  app.post('/api/admin/actors/reload', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = getTenant(request);
    const denial = checkTenantPermission(config, sessions, request, tenant, 'owner');
    if (denial) return reply.code(denial.status).send(denial.body);
    const result = await runtime.reloadActors();
    return reply.send(result);
  });
}
