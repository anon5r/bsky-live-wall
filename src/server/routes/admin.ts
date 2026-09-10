/**
 * 運営用管理 API (テナントに属するもの)。
 *
 * 認証は `admin-auth.ts` の `createAdminAuth` に一本化してある
 * (セッション Cookie / Bearer トークン / トークン未設定時の loopback 例外)。
 *
 * multi モードでは認証に加えて「そのテナントのメンバーか」も確認する
 * (`permission.ts` の `checkTenantPermission`)。認証さえ通れば他人のテナントを
 * 操作できてしまうのを防ぐため。single モードでは従来どおりメンバーの概念を使わない。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { TenantRuntime } from '../../shared/ingest-contracts.js';
import { createLogger } from '../../shared/logger.js';
import { AdminSessionStore, SESSION_COOKIE, readCookie, safeEqual } from '../admin-session.js';
import {
  badRequest,
  createAdminAuth,
  isRateLimited,
  recordAuthFailure,
  routePath,
  tooManyRequests,
  unauthorized,
} from '../admin-auth.js';
import { checkTenantPermission } from '../permission.js';
import { getTenant } from '../tenant-context.js';

const logger = createLogger('admin');

/** 監査ログ。誰がいつ何をしたかを追えるようにする。 */
const AUDIT_LIMIT = 200;
/** キーワードの最小文字数。短すぎると無関係な投稿を大量に拾う。 */
const MIN_KEYWORD_LENGTH = 2;

/** 監視語の入力を検証する。問題があればエラーメッセージ (文字列) を返す。 */
function parseTerms(
  terms: unknown[]
): { value: string; type: 'hashtag' | 'keyword' }[] | string {
  const parsed: { value: string; type: 'hashtag' | 'keyword' }[] = [];
  for (const entry of terms) {
    if (typeof entry !== 'object' || entry === null) {
      return 'terms の要素は { value, type } のオブジェクトです';
    }
    const { value, type } = entry as { value?: unknown; type?: unknown };
    if (typeof value !== 'string' || value.trim() === '') {
      return 'value は空でない文字列で指定してください';
    }
    if (type !== 'hashtag' && type !== 'keyword') {
      return "type は 'hashtag' か 'keyword' で指定してください";
    }
    // キーワードは短すぎると無関係な投稿を大量に拾う。
    if (type === 'keyword' && value.trim().length < MIN_KEYWORD_LENGTH) {
      return `キーワードは ${MIN_KEYWORD_LENGTH} 文字以上で指定してください: ${value}`;
    }
    parsed.push({ value, type });
  }
  return parsed;
}

interface AuditEntry {
  at: number;
  action: string;
  detail: string;
  ip: string;
  /** セッション ID の先頭のみ。完全な ID はログに残さない。 */
  actor: string;
}

const auditLog: AuditEntry[] = [];

function recordAudit(
  action: string,
  detail: string,
  request: FastifyRequest,
  actorOverride?: string,
  sessions?: AdminSessionStore
): void {
  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
  const session = sessions?.verify(sessionId);
  // OAuth ログインならハンドルで記録する。誰の操作かを人間が読める形で残すため。
  const actor =
    actorOverride ??
    session?.handle ??
    (sessionId ? `session:${sessionId.slice(0, 8)}` : 'bearer');
  auditLog.unshift({ at: Date.now(), action, detail, ip: request.ip, actor });
  if (auditLog.length > AUDIT_LIMIT) auditLog.length = AUDIT_LIMIT;
  logger.info(`管理操作: ${action}`, { detail, ip: request.ip, actor });
}

/** `?wall=` / body.wall からウォールを解決する。省略時は既定ウォール。 */
function pickWall(tenant: TenantRuntime, id: unknown) {
  return typeof id === 'string' && id !== '' ? tenant.getWall(id) : tenant.getDefaultWall();
}

function wallNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'wall_not_found' });
}

/**
 * セッション管理 (ログイン / ログアウト / 一覧 / 監査ログ)。
 *
 * これらはテナントに属さない (どのテナントの管理者かに関わらず、ログイン機構は
 * サーバー全体で 1 つ)。`createServer` からルート直下にのみ登録する。
 */
export function registerAdminSessionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  sessions: AdminSessionStore,
): void {
  /** トークンによるログイン・Bearer 認証が有効か。 */
  const tokenAuthEnabled =
    config.admin.authMode === 'token' || config.admin.authMode === 'both';
  const adminAuth = createAdminAuth(config, sessions);

  /**
   * ログイン不要で通してよい経路 (ログイン API 自身のみ)。
   * startsWith にすると /api/admin/sessions/revoke-all まで素通りするため、
   * クエリを除いた完全一致で判定する。
   */
  const isLoginRoute = (request: FastifyRequest): boolean => {
    return routePath(request).endsWith('/api/admin/session') && request.method === 'POST';
  };

  app.addHook('preHandler', (request, reply, done) => {
    // このフックは `app` に直接登録するため、ここで対象を絞らないと
    // 同じインスタンスに登録された他の経路 (ヘルスチェック等) にまで
    // 認証がかかってしまう。
    if (!routePath(request).includes('/api/admin')) {
      done();
      return;
    }
    if (isLoginRoute(request)) {
      done();
      return;
    }
    adminAuth(request, reply);
    done();
  });

  app.post<{ Body: { token?: unknown } }>('/api/admin/session', async (request, reply) => {
    const ip = request.ip;
    if (isRateLimited(ip)) {
      logger.warn('ログイン試行が続いたため一時的に拒否', { ip });
      return tooManyRequests(reply);
    }

    if (!tokenAuthEnabled) {
      return reply
        .code(400)
        .send({ error: 'token_auth_disabled', message: 'AUTH_MODE=oauth ではトークンログインは使えません' });
    }

    const configured = config.admin.token;
    const { token } = request.body ?? {};

    // トークン未設定 (loopback 限定運用) の場合はトークン検証を省く。
    // ここへ到達している時点で loopback からのアクセスであることは
    // preHandler より前の isLoginRoute 経路で保証されないため、改めて判定する。
    if (configured === '') {
      if (config.server.trustProxy) {
        recordAuthFailure(ip);
        return unauthorized(reply);
      }
    } else if (typeof token !== 'string' || !safeEqual(token, configured)) {
      recordAuthFailure(ip);
      return unauthorized(reply);
    }

    const session = sessions.create(ip, String(request.headers['user-agent'] ?? ''));
    // Secure は HTTPS のときだけ付ける。localhost の HTTP 運用を壊さないため。
    const secure = request.protocol === 'https';
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessions.ttlSeconds}` +
        (secure ? '; Secure' : '')
    );
    recordAudit(
      'login',
      `expiresAt=${new Date(session.expiresAt).toISOString()}`,
      request,
      `session:${session.id.slice(0, 8)}`
    );
    return reply.send({ ok: true, expiresAt: session.expiresAt });
  });

  app.delete('/api/admin/session', async (request, reply) => {
    const id = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (id) sessions.revoke(id);
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    recordAudit('logout', '', request, undefined, sessions);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/sessions', async (_request, reply) => {
    // セッション ID そのものは返さない。
    const list = sessions.list().map((s) => ({
      idPrefix: s.id.slice(0, 8),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      handle: s.handle ?? null,
      did: s.did ?? null,
    }));
    return reply.send({ sessions: list, ttlHours: config.admin.sessionTtlHours });
  });

  app.post('/api/admin/sessions/revoke-all', async (request, reply) => {
    const revoked = sessions.revokeAll();
    reply.header(`Set-Cookie`, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    recordAudit('revoke-all-sessions', `${revoked} 件`, request, undefined, sessions);
    return reply.send({ revoked });
  });

  app.get('/api/admin/audit', async (_request, reply) => {
    return reply.send({ entries: auditLog });
  });
}

/**
 * テナントに属する管理 API (状態表示・モデレーション操作・ウォール管理など)。
 * `createServer` がテナント解決フックの内側 (ルート直下 / `/e/:eventId` の両方) から
 * 登録する。
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  sessions: AdminSessionStore,
): void {
  const adminAuth = createAdminAuth(config, sessions);

  app.addHook('preHandler', (request, reply, done) => {
    // このインスタンスには `/api/stream`・`/api/posts`・`/api/walls` など
    // 認証不要な経路も同居しているため、`/api/admin` 配下だけに絞る。
    if (!routePath(request).includes('/api/admin')) {
      done();
      return;
    }
    adminAuth(request, reply);
    done();
  });

  /**
   * テナントのメンバーであることを要求する。multi モードのみ判定する
   * (single は従来どおり)。拒否ならレスポンスを送信して true を返す。
   */
  const requireRole = (
    request: FastifyRequest,
    reply: FastifyReply,
    tenant: TenantRuntime,
    required: 'owner' | 'moderator'
  ): boolean => {
    const denial = checkTenantPermission(config, sessions, request, tenant, required);
    if (denial) {
      reply.code(denial.status).send(denial.body);
      return true;
    }
    return false;
  };

  // ---- 状態と操作 ----

  app.get<{ Querystring: { wall?: string } }>('/api/admin/state', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const wall = pickWall(tenant, request.query.wall);
    if (!wall) return wallNotFound(reply);
    const state = wall.getState();
    const recent = wall.getRecent(config.buffer.backlogSize);
    const pending = wall.getPending(config.buffer.backlogSize);
    const hidden = tenant.getHidden(config.buffer.backlogSize);
    const blocked = tenant.getBlockedActors();
    const modLists = tenant.getModLists();
    const jetstreamHosts = tenant.getJetstreamHosts();
    return reply.send({
      state,
      recent,
      pending,
      hidden,
      blocked,
      modLists,
      jetstreamHosts,
      backfill: tenant.getBackfillStatus(),
      walls: tenant.getWalls(),
    });
  });

  app.post<{ Body: { paused?: unknown } }>('/api/admin/pause', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { paused } = request.body ?? {};
    if (typeof paused !== 'boolean') {
      return badRequest(reply, 'paused は boolean で指定してください');
    }
    recordAudit('pause', String(paused), request, undefined, sessions);
    tenant.setPaused(paused);
    const state = tenant.getDefaultWall().getState();
    return reply.send({ state });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/hide', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('hide', uri, request, undefined, sessions);
    const ok = tenant.hide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/unhide', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('unhide', uri, request, undefined, sessions);
    const ok = tenant.unhide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/approve', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    const wall = pickWall(tenant, (request.body as { wall?: unknown } | undefined)?.wall);
    if (!wall) return wallNotFound(reply);
    recordAudit('approve', uri, request, undefined, sessions);
    const ok = wall.approve(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/block', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    recordAudit('block', did, request, undefined, sessions);
    const removed = tenant.blockActor(did);
    return reply.send({ removed });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/unblock', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    recordAudit('unblock', did, request, undefined, sessions);
    const restored = tenant.unblockActor(did);
    return reply.send({ restored });
  });

  // ---- ウォール ----

  app.get('/api/admin/walls', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    return reply.send({ walls: tenant.getWalls() });
  });

  app.post<{ Body: { id?: unknown; name?: unknown; terms?: unknown } }>(
    '/api/admin/walls',
    async (request, reply) => {
      const tenant = getTenant(request);
      // ウォールの作成はテナント構成の変更にあたるため owner 限定。
      if (requireRole(request, reply, tenant, 'owner')) return;
      const { id, name, terms } = request.body ?? {};
      if (typeof name !== 'string' || name.trim() === '') {
        return badRequest(reply, 'name は空でない文字列で指定してください');
      }
      if (!Array.isArray(terms)) {
        return badRequest(reply, 'terms は配列で指定してください');
      }
      const parsed = parseTerms(terms);
      if (typeof parsed === 'string') return badRequest(reply, parsed);

      try {
        const created = tenant.createWall({
          ...(typeof id === 'string' && id !== '' ? { id } : {}),
          name,
          terms: parsed,
        });
        recordAudit('wall-create', `${created.id} (${created.name})`, request, undefined, sessions);
        return reply.send({ wall: created });
      } catch (err) {
        return badRequest(reply, err instanceof Error ? err.message : 'ウォールを作成できません');
      }
    }
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown; display?: unknown } }>(
    '/api/admin/walls/:id',
    async (request, reply) => {
      const tenant = getTenant(request);
      // 改名もテナント構成の変更にあたるため owner 限定。
      if (requireRole(request, reply, tenant, 'owner')) return;
      const { name, display } = request.body ?? {};
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return badRequest(reply, 'name は空でない文字列で指定してください');
      }
      const updated = tenant.updateWall(request.params.id, {
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof display === 'object' && display !== null
          ? { display: display as Record<string, never> }
          : {}),
      });
      if (!updated) return wallNotFound(reply);
      recordAudit('wall-update', updated.id, request, undefined, sessions);
      return reply.send({ wall: updated });
    }
  );

  app.delete<{ Params: { id: string } }>('/api/admin/walls/:id', async (request, reply) => {
    const tenant = getTenant(request);
    // 削除もテナント構成の変更にあたるため owner 限定。
    if (requireRole(request, reply, tenant, 'owner')) return;
    const ok = tenant.deleteWall(request.params.id);
    if (!ok) {
      return badRequest(reply, '削除できません (存在しないか、既定ウォールです)');
    }
    recordAudit('wall-delete', request.params.id, request, undefined, sessions);
    return reply.send({ ok: true });
  });

  // ---- 監視設定 ----

  app.get<{ Querystring: { wall?: string } }>('/api/admin/terms', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const wall = pickWall(tenant, request.query.wall);
    if (!wall) return wallNotFound(reply);
    return reply.send({ terms: wall.getTerms() });
  });

  /** 監視語の一覧をまとめて差し替える。追加・削除はクライアント側で組み立てる。 */
  app.post<{ Body: { terms?: unknown; wall?: unknown } }>(
    '/api/admin/terms',
    async (request, reply) => {
      const tenant = getTenant(request);
      if (requireRole(request, reply, tenant, 'moderator')) return;
      const wall = pickWall(tenant, request.body?.wall);
      if (!wall) return wallNotFound(reply);
      const { terms } = request.body ?? {};
      if (!Array.isArray(terms)) {
        return badRequest(reply, 'terms は配列で指定してください');
      }
      // 検証はすべて適用の前に済ませる。
      // 途中で弾く場合でも、設定を書き換えたあとで 400 を返してはいけない。
      const parsed = parseTerms(terms);
      if (typeof parsed === 'string') return badRequest(reply, parsed);

      const applied = wall.setTerms(parsed);
      recordAudit(
        'terms',
        `${wall.id}: ${applied.map((t) => `${t.type}:${t.value}`).join(',')}`,
        request,
        undefined,
        sessions
      );
      return reply.send({ terms: applied });
    }
  );

  app.get('/api/admin/jetstream', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const state = tenant.getDefaultWall().getState();
    return reply.send({
      hosts: tenant.getJetstreamHosts(),
      current: state.jetstream.host,
      connected: state.jetstream.connected,
    });
  });

  app.post<{ Body: { host?: unknown } }>('/api/admin/jetstream', async (request, reply) => {
    const tenant = getTenant(request);
    // Jetstream 接続は全テナント共有のため、この操作は他テナントにも影響する。
    // 影響範囲の広さに鑑みて owner 限定にする。
    if (requireRole(request, reply, tenant, 'owner')) return;
    const { host } = request.body ?? {};
    if (typeof host !== 'string' || host === '') {
      return badRequest(reply, 'host は空でない文字列で指定してください');
    }
    const ok = tenant.switchJetstreamHost(host);
    if (!ok) {
      return badRequest(reply, '候補にないホストです');
    }
    recordAudit('jetstream-switch', host, request, undefined, sessions);
    return reply.send({ ok: true, host });
  });

  // ---- バックフィル (過去の取り込み) ----

  app.get('/api/admin/backfill', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    return reply.send({ status: tenant.getBackfillStatus() });
  });

  app.post<{ Body: { minutes?: unknown; wall?: unknown } }>(
    '/api/admin/backfill',
    async (request, reply) => {
      const tenant = getTenant(request);
      if (requireRole(request, reply, tenant, 'moderator')) return;
      const { minutes, wall } = request.body ?? {};
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
        return badRequest(reply, 'minutes は数値で指定してください');
      }
      if (wall !== undefined && typeof wall !== 'string') {
        return badRequest(reply, 'wall は文字列で指定してください');
      }
      const result = tenant.startBackfill({
        minutes,
        ...(typeof wall === 'string' && wall !== '' ? { wallId: wall } : {}),
      });
      if (!result.ok) {
        return badRequest(reply, result.message ?? 'バックフィルを開始できません');
      }
      recordAudit(
        'backfill',
        `${minutes} 分 / 対象: ${typeof wall === 'string' && wall !== '' ? wall : '全ウォール'}`,
        request,
        undefined,
        sessions
      );
      return reply.send({ ok: true, status: tenant.getBackfillStatus() });
    }
  );

  // ---- モデレーションリスト ----

  app.get('/api/admin/modlists', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    return reply.send({ subscribed: tenant.getModLists() });
  });

  /**
   * ログイン中のアカウント (または指定したアカウント) が持つリストを返す。
   * リストは公開データのため、認証なしで取得できる。
   */
  app.get<{ Querystring: { actor?: string } }>(
    '/api/admin/modlists/available',
    async (request, reply) => {
      const session = sessions.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
      const actor = request.query.actor?.trim() || session?.did || session?.handle;
      if (!actor) {
        return badRequest(
          reply,
          'アカウントを特定できません。OAuth でログインするか actor を指定してください'
        );
      }
      try {
        const params = new URLSearchParams({ actor, limit: '100' });
        const res = await fetch(
          `${config.appview.url}/xrpc/app.bsky.graph.getLists?${params}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          lists?: { uri: string; name?: string; purpose?: string; listItemCount?: number }[];
        };
        const lists = (data.lists ?? []).map((l) => ({
          uri: l.uri,
          name: l.name ?? l.uri,
          purpose: l.purpose ?? '',
          itemCount: l.listItemCount ?? 0,
        }));
        return reply.send({ actor, lists });
      } catch (err) {
        logger.warn('リスト一覧の取得に失敗しました', { actor, err });
        return reply
          .code(502)
          .send({ error: 'fetch_failed', message: 'リスト一覧を取得できませんでした' });
      }
    }
  );

  app.post<{ Body: { uri?: unknown } }>('/api/admin/modlists', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || !uri.startsWith('at://')) {
      return badRequest(reply, 'uri は at:// で始まる文字列で指定してください');
    }
    recordAudit('modlist-subscribe', uri, request, undefined, sessions);
    const result = await tenant.subscribeModList(uri);
    return reply.send(result);
  });

  app.delete<{ Body: { uri?: unknown } }>('/api/admin/modlists', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('modlist-unsubscribe', uri, request, undefined, sessions);
    return reply.send({ ok: tenant.unsubscribeModList(uri) });
  });

  app.post<{ Body: { wall?: unknown } }>('/api/admin/clear', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const wall = pickWall(tenant, request.body?.wall);
    if (!wall) return wallNotFound(reply);
    recordAudit('clear', wall.id, request, undefined, sessions);
    wall.clear();
    return reply.send({ ok: true });
  });
}
