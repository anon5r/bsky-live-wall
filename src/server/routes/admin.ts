/**
 * 運営用管理 API。
 *
 * 認証は 2 経路。
 * - **セッション Cookie** (管理画面が使う): ログイン時に一度だけトークンを検証し、
 *   HttpOnly Cookie でセッション ID を渡す。トークンをブラウザに保存しない。
 * - **Bearer トークン** (スクリプト・監視用): `Authorization: Bearer <ADMIN_TOKEN>`。
 *
 * `ADMIN_TOKEN` が空文字の場合は loopback アドレスからのアクセスのみ許可する。
 * ただし `TRUST_PROXY=true` (リバースプロキシ配下) では、リモートの利用者が
 * プロキシの loopback アドレスとして見えるため、この例外を無効化しトークンを必須とする。
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { WallSource } from '../../shared/contracts.js';
import { createLogger } from '../../shared/logger.js';
import {
  AdminSessionStore,
  SESSION_COOKIE,
  readCookie,
  safeEqual,
} from '../admin-session.js';

const logger = createLogger('admin');

/**
 * 認証判定に使う経路を返す。
 *
 * これらのルートは `/api/...` と `/e/<eventId>/api/...` の両方に登録されるため、
 * `request.url` の前方一致で判定すると、プレフィックス付きの経路が
 * 認証ガードを素通りしてしまう。登録時のルートパターンを優先して使う。
 */
function routePath(request: FastifyRequest): string {
  const pattern = request.routeOptions?.url;
  if (typeof pattern === 'string' && pattern !== '') return pattern;
  return request.url.split('?')[0] ?? '';
}

/** リモートアドレスが loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) かどうか判定する。 */
function isLoopback(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || ip === '::1';
}

/** 定数時間比較でトークンを検証する。長さが異なる場合は即座に false。 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 認証失敗の総当たり対策。IP ごとに失敗回数を数える。 */
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;
const AUTH_FAIL_LIMIT = 10;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
    return;
  }
  entry.count += 1;
  // 際限なく増えないよう、期限切れのエントリを間引く。
  if (authFailures.size > 1000) {
    for (const [key, value] of authFailures) {
      if (value.resetAt <= now) authFailures.delete(key);
    }
  }
}

function isRateLimited(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= AUTH_FAIL_LIMIT;
}

function tooManyRequests(reply: FastifyReply): FastifyReply {
  return reply.code(429).send({ error: 'too_many_requests' });
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'unauthorized' });
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', message });
}

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
function pickWall(source: WallSource, id: unknown) {
  return typeof id === 'string' && id !== '' ? source.getWall(id) : source.getDefaultWall();
}

function wallNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'wall_not_found' });
}

export function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  source: WallSource,
  sessions: AdminSessionStore,
): void {
  /** トークンによるログイン・Bearer 認証が有効か。 */
  const tokenAuthEnabled =
    config.admin.authMode === 'token' || config.admin.authMode === 'both';
  /**
   * ログイン不要で通してよい経路 (ログイン API 自身のみ)。
   * startsWith にすると /api/admin/sessions/revoke-all まで素通りするため、
   * クエリを除いた完全一致で判定する。
   */
  const isLoginRoute = (request: FastifyRequest): boolean => {
    return routePath(request).endsWith('/api/admin/session') && request.method === 'POST';
  };

  const adminAuth = (request: FastifyRequest, reply: FastifyReply): void => {
    const token = config.admin.token;
    const ip = request.ip;

    if (isRateLimited(ip)) {
      logger.warn('管理 API の認証失敗が続いたため一時的に拒否', { ip });
      tooManyRequests(reply);
      return;
    }

    // 1. セッション Cookie。トークンログイン・OAuth ログインの両方がこれを使う。
    const session = sessions.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (session) {
      // Cookie 認証は CSRF の対象になる。SameSite に加えて、
      // クロスオリジンからは付与できないカスタムヘッダを状態変更操作に要求する。
      if (request.method !== 'GET' && request.headers['x-requested-with'] !== 'bsky-live-wall') {
        badRequest(reply, 'X-Requested-With ヘッダが必要です');
      }
      return;
    }

    // 2. これ以降はトークンによる認証。AUTH_MODE=oauth では一切認めない。
    //    loopback 例外もトークン方式の利便機能であり、OAuth 専用モードでは適用しない。
    if (!tokenAuthEnabled) {
      recordAuthFailure(ip);
      unauthorized(reply);
      return;
    }

    // 3. トークン未設定時の loopback 例外 (会場 PC での単独運用向け)。
    //    プロキシ配下ではリモートの利用者も loopback に見えるため無効化する。
    if (token === '') {
      if (config.server.trustProxy) {
        // 起動時に弾いているはずだが二重に防ぐ。
        logger.error('TRUST_PROXY=true では ADMIN_TOKEN が必須です');
        unauthorized(reply);
        return;
      }
      if (!isLoopback(ip)) {
        logger.warn('loopback 以外からの管理 API アクセスを拒否', { ip });
        recordAuthFailure(ip);
        unauthorized(reply);
      }
      return;
    }

    // 4. Bearer トークン (スクリプト・監視用)
    const header = request.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !match[1] || !tokenMatches(match[1], token)) {
      recordAuthFailure(ip);
      unauthorized(reply);
    }
  };

  app.addHook('preHandler', (request, reply, done) => {
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

  // ---- セッション ----

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
      if (config.server.trustProxy || !isLoopback(ip)) {
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

  // ---- 状態と操作 ----

  app.get<{ Querystring: { wall?: string } }>('/api/admin/state', async (request, reply) => {
    const wall = pickWall(source, request.query.wall);
    if (!wall) return wallNotFound(reply);
    const state = wall.getState();
    const recent = wall.getRecent(config.buffer.backlogSize);
    const pending = wall.getPending(config.buffer.backlogSize);
    const hidden = source.getHidden(config.buffer.backlogSize);
    const blocked = source.getBlockedActors();
    const modLists = source.getModLists();
    const jetstreamHosts = source.getJetstreamHosts();
    return reply.send({
      state,
      recent,
      pending,
      hidden,
      blocked,
      modLists,
      jetstreamHosts,
      backfill: source.getBackfillStatus(),
      walls: source.getWalls(),
    });
  });

  app.post<{ Body: { paused?: unknown } }>('/api/admin/pause', async (request, reply) => {
    const { paused } = request.body ?? {};
    if (typeof paused !== 'boolean') {
      return badRequest(reply, 'paused は boolean で指定してください');
    }
    recordAudit('pause', String(paused), request, undefined, sessions);
    source.setPaused(paused);
    const state = source.getDefaultWall().getState();
    return reply.send({ state });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/hide', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('hide', uri, request, undefined, sessions);
    const ok = source.hide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/unhide', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('unhide', uri, request, undefined, sessions);
    const ok = source.unhide(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { uri?: unknown } }>('/api/admin/approve', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    const wall = pickWall(source, (request.body as { wall?: unknown } | undefined)?.wall);
    if (!wall) return wallNotFound(reply);
    recordAudit('approve', uri, request, undefined, sessions);
    const ok = wall.approve(uri);
    return reply.send({ ok });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/block', async (request, reply) => {
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    recordAudit('block', did, request, undefined, sessions);
    const removed = source.blockActor(did);
    return reply.send({ removed });
  });

  app.post<{ Body: { did?: unknown } }>('/api/admin/unblock', async (request, reply) => {
    const { did } = request.body ?? {};
    if (typeof did !== 'string' || did === '') {
      return badRequest(reply, 'did は空でない文字列で指定してください');
    }
    recordAudit('unblock', did, request, undefined, sessions);
    const restored = source.unblockActor(did);
    return reply.send({ restored });
  });

  // ---- ウォール ----

  app.get('/api/admin/walls', async (_request, reply) =>
    reply.send({ walls: source.getWalls() })
  );

  app.post<{ Body: { id?: unknown; name?: unknown; terms?: unknown } }>(
    '/api/admin/walls',
    async (request, reply) => {
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
        const created = source.createWall({
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
      const { name, display } = request.body ?? {};
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return badRequest(reply, 'name は空でない文字列で指定してください');
      }
      const updated = source.updateWall(request.params.id, {
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
    const ok = source.deleteWall(request.params.id);
    if (!ok) {
      return badRequest(reply, '削除できません (存在しないか、既定ウォールです)');
    }
    recordAudit('wall-delete', request.params.id, request, undefined, sessions);
    return reply.send({ ok: true });
  });

  // ---- 監視設定 ----

  app.get<{ Querystring: { wall?: string } }>('/api/admin/terms', async (request, reply) => {
    const wall = pickWall(source, request.query.wall);
    if (!wall) return wallNotFound(reply);
    return reply.send({ terms: wall.getTerms() });
  });

  /** 監視語の一覧をまとめて差し替える。追加・削除はクライアント側で組み立てる。 */
  app.post<{ Body: { terms?: unknown; wall?: unknown } }>(
    '/api/admin/terms',
    async (request, reply) => {
    const wall = pickWall(source, request.body?.wall);
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

  app.get('/api/admin/jetstream', async (_request, reply) => {
    const state = source.getDefaultWall().getState();
    return reply.send({
      hosts: source.getJetstreamHosts(),
      current: state.jetstream.host,
      connected: state.jetstream.connected,
    });
  });

  app.post<{ Body: { host?: unknown } }>('/api/admin/jetstream', async (request, reply) => {
    const { host } = request.body ?? {};
    if (typeof host !== 'string' || host === '') {
      return badRequest(reply, 'host は空でない文字列で指定してください');
    }
    const ok = source.switchJetstreamHost(host);
    if (!ok) {
      return badRequest(reply, '候補にないホストです');
    }
    recordAudit('jetstream-switch', host, request, undefined, sessions);
    return reply.send({ ok: true, host });
  });

  // ---- バックフィル (過去の取り込み) ----

  app.get('/api/admin/backfill', async (_request, reply) =>
    reply.send({ status: source.getBackfillStatus() })
  );

  app.post<{ Body: { minutes?: unknown; wall?: unknown } }>(
    '/api/admin/backfill',
    async (request, reply) => {
      const { minutes, wall } = request.body ?? {};
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
        return badRequest(reply, 'minutes は数値で指定してください');
      }
      if (wall !== undefined && typeof wall !== 'string') {
        return badRequest(reply, 'wall は文字列で指定してください');
      }
      const result = source.startBackfill({
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
      return reply.send({ ok: true, status: source.getBackfillStatus() });
    }
  );

  // ---- モデレーションリスト ----

  app.get('/api/admin/modlists', async (_request, reply) =>
    reply.send({ subscribed: source.getModLists() })
  );

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
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || !uri.startsWith('at://')) {
      return badRequest(reply, 'uri は at:// で始まる文字列で指定してください');
    }
    recordAudit('modlist-subscribe', uri, request, undefined, sessions);
    const result = await source.subscribeModList(uri);
    return reply.send(result);
  });

  app.delete<{ Body: { uri?: unknown } }>('/api/admin/modlists', async (request, reply) => {
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('modlist-unsubscribe', uri, request, undefined, sessions);
    return reply.send({ ok: source.unsubscribeModList(uri) });
  });

  app.post<{ Body: { wall?: unknown } }>('/api/admin/clear', async (request, reply) => {
    const wall = pickWall(source, request.body?.wall);
    if (!wall) return wallNotFound(reply);
    recordAudit('clear', wall.id, request, undefined, sessions);
    wall.clear();
    return reply.send({ ok: true });
  });
}
