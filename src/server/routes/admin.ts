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
import type {
  ApprovalSetting,
  DisplayConfig,
  ScreenImagePosition,
  ScreenImageSize,
  ScreenMode,
  WallModerationMode,
  WallScreen,
} from '../../shared/types.js';
import type { TenantSettings } from '../../shared/tenancy.js';
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
import { resolveActor } from '../oauth/client.js';
import { IMAGE_EXTENSIONS, type ImageStore } from '../image-store.js';

const logger = createLogger('admin');

/** 監査ログ。誰がいつ何をしたかを追えるようにする。 */
const AUDIT_LIMIT = 200;
/** キーワードの最小文字数。短すぎると無関係な投稿を大量に拾う。 */
const MIN_KEYWORD_LENGTH = 2;

type ParsedTerm = { value: string; type: 'hashtag' | 'keyword'; requireApproval: ApprovalSetting };

/** ウォールの承認モードを検証する。未指定は継承 ('inherit')。 */
function parseWallModerationMode(raw: unknown): WallModerationMode | undefined {
  if (raw === undefined || raw === null) return 'inherit';
  if (raw === 'inherit' || raw === 'open' || raw === 'approve') return raw;
  return undefined;
}

/** 承認要否の指定を検証する。未指定は継承 ('inherit')。 */
function parseApprovalSetting(raw: unknown): ApprovalSetting | undefined {
  if (raw === undefined || raw === null) return 'inherit';
  if (raw === 'inherit' || raw === 'always' || raw === 'never') return raw;
  return undefined;
}

/**
 * 表示設定の入力を検証する。指定されたキーだけを取り出し、想定外の値は弾く。
 * 問題があればエラーメッセージ (文字列) を返す。
 */
function parseDisplay(raw: unknown): Partial<DisplayConfig> | string {
  if (typeof raw !== 'object' || raw === null) return 'display はオブジェクトで指定してください';
  const input = raw as Record<string, unknown>;
  const out: Partial<DisplayConfig> = {};

  const numbers: { key: 'maxCards' | 'columns' | 'cardTtlSec'; min: number; max: number }[] = [
    { key: 'maxCards', min: 1, max: 500 },
    { key: 'columns', min: 1, max: 6 },
    { key: 'cardTtlSec', min: 0, max: 86_400 },
  ];
  for (const { key, min, max } of numbers) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      return `${key} は ${min} 以上 ${max} 以下の数値で指定してください`;
    }
    out[key] = Math.floor(value);
  }

  const booleans: (
    | 'showImages'
    | 'showClock'
    | 'showSeconds'
    | 'showTerms'
    | 'showKeywords'
  )[] = ['showImages', 'showClock', 'showSeconds', 'showTerms', 'showKeywords'];
  for (const key of booleans) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return `${key} は boolean で指定してください`;
    out[key] = value;
  }
  return out;
}

/** 1 ウォールあたりの除外キーワードの上限。ingest 側と同じ値。 */
const MAX_EXCLUDE_TERMS = 50;

/** 除外キーワードの入力を検証する。問題があればエラーメッセージ (文字列) を返す。 */
function parseExcludeTerms(terms: unknown[]): { value: string }[] | string {
  if (terms.length > MAX_EXCLUDE_TERMS) {
    return `除外キーワードは ${MAX_EXCLUDE_TERMS} 件までです`;
  }
  const parsed: { value: string }[] = [];
  for (const entry of terms) {
    const value = typeof entry === 'string' ? entry : (entry as { value?: unknown })?.value;
    if (typeof value !== 'string' || value.trim() === '') {
      return '除外キーワードは空でない文字列で指定してください';
    }
    if (value.trim().length < MIN_KEYWORD_LENGTH) {
      return `除外キーワードは ${MIN_KEYWORD_LENGTH} 文字以上で指定してください: ${value}`;
    }
    parsed.push({ value });
  }
  return parsed;
}

/** 監視語の入力を検証する。問題があればエラーメッセージ (文字列) を返す。 */
function parseTerms(terms: unknown[]): ParsedTerm[] | string {
  const parsed: ParsedTerm[] = [];
  for (const entry of terms) {
    if (typeof entry !== 'object' || entry === null) {
      return 'terms の要素は { value, type } のオブジェクトです';
    }
    const { value, type, requireApproval } = entry as {
      value?: unknown;
      type?: unknown;
      requireApproval?: unknown;
    };
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
    const approval = parseApprovalSetting(requireApproval);
    if (approval === undefined) {
      return "requireApproval は 'inherit' / 'always' / 'never' のいずれかです";
    }
    parsed.push({ value, type, requireApproval: approval });
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

/** システム管理 API (`routes/system.ts`) が全テナント分の監査ログを見るために使う。 */
export function getAuditLog(): AuditEntry[] {
  return auditLog;
}

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
  images: ImageStore
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
    const settings = tenant.getTenant().settings;
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
      // 管理画面はプロフィールと候補検索を AppView へ直接問い合わせる。
      // 独自の AppView を指している場合もあるため、その宛先を伝える。
      appviewUrl: config.appview.url,
      // 管理画面がテナント設定を編集できるよう、状態と一緒に返す。
      // 秘匿すべき値は含めない (認証情報はここに無い)。
      settings: {
        title: settings.title,
        subtitle: settings.subtitle,
        showBlueskyLogo: settings.showBlueskyLogo !== false,
        animateTitleGradient: settings.animateTitleGradient === true,
        backfillPresets: settings.backfillPresets ?? [],
        allowReplies: settings.allowReplies,
        filterLabeled: settings.filterLabeled,
        ngWords: settings.ngWords,
        ngPatterns: settings.ngPatterns,
      },
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

  app.post<{
    Body: {
      id?: unknown;
      name?: unknown;
      terms?: unknown;
      moderationMode?: unknown;
      keywordRequireApproval?: unknown;
      backfillMinutes?: unknown;
    };
  }>(
    '/api/admin/walls',
    async (request, reply) => {
      const tenant = getTenant(request);
      // ウォールの作成はテナント構成の変更にあたるため owner 限定。
      if (requireRole(request, reply, tenant, 'owner')) return;
      const { id, name, terms, moderationMode, keywordRequireApproval } = request.body ?? {};
      if (typeof name !== 'string' || name.trim() === '') {
        return badRequest(reply, 'name は空でない文字列で指定してください');
      }
      if (!Array.isArray(terms)) {
        return badRequest(reply, 'terms は配列で指定してください');
      }
      const parsed = parseTerms(terms);
      if (typeof parsed === 'string') return badRequest(reply, parsed);
      const mode = parseWallModerationMode(moderationMode);
      if (mode === undefined) {
        return badRequest(reply, "moderationMode は 'inherit' / 'open' / 'approve' のいずれかです");
      }
      const keywordApproval = parseApprovalSetting(keywordRequireApproval);
      if (keywordApproval === undefined) {
        return badRequest(
          reply,
          "keywordRequireApproval は 'inherit' / 'always' / 'never' のいずれかです"
        );
      }

      // 作成直後に過去分を取り込むかどうか。会場では「作ってすぐ埋まっていてほしい」ため。
      const backfillMinutes =
        request.body?.backfillMinutes === undefined
          ? 0
          : Number.parseInt(String(request.body.backfillMinutes), 10);
      if (!Number.isFinite(backfillMinutes) || backfillMinutes < 0 || backfillMinutes > 2160) {
        return badRequest(reply, 'backfillMinutes は 0 〜 2160 で指定してください');
      }

      try {
        const created = tenant.createWall({
          ...(typeof id === 'string' && id !== '' ? { id } : {}),
          name,
          terms: parsed,
          moderationMode: mode,
          keywordRequireApproval: keywordApproval,
        });
        recordAudit('wall-create', `${created.id} (${created.name})`, request, undefined, sessions);

        let backfill: { ok: boolean; message?: string } | undefined;
        if (backfillMinutes > 0) {
          backfill = tenant.startBackfill({ minutes: backfillMinutes, wallId: created.id });
          if (backfill.ok) {
            recordAudit('backfill', `${created.id}: ${backfillMinutes} 分`, request, undefined, sessions);
          }
        }
        return reply.send({ wall: created, ...(backfill ? { backfill } : {}) });
      } catch (err) {
        return badRequest(reply, err instanceof Error ? err.message : 'ウォールを作成できません');
      }
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      name?: unknown;
      display?: unknown;
      moderationMode?: unknown;
      keywordRequireApproval?: unknown;
    };
  }>(
    '/api/admin/walls/:id',
    async (request, reply) => {
      const tenant = getTenant(request);
      // 改名もテナント構成の変更にあたるため owner 限定。
      if (requireRole(request, reply, tenant, 'owner')) return;
      const { name, display, moderationMode, keywordRequireApproval } = request.body ?? {};
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return badRequest(reply, 'name は空でない文字列で指定してください');
      }
      // 未指定と「継承に戻す」を区別する。undefined のときだけ変更しない。
      const mode =
        moderationMode === undefined ? undefined : parseWallModerationMode(moderationMode);
      if (moderationMode !== undefined && mode === undefined) {
        return badRequest(reply, "moderationMode は 'inherit' / 'open' / 'approve' のいずれかです");
      }
      const keywordApproval =
        keywordRequireApproval === undefined
          ? undefined
          : parseApprovalSetting(keywordRequireApproval);
      if (keywordRequireApproval !== undefined && keywordApproval === undefined) {
        return badRequest(
          reply,
          "keywordRequireApproval は 'inherit' / 'always' / 'never' のいずれかです"
        );
      }
      let parsedDisplay: Partial<DisplayConfig> | undefined;
      if (display !== undefined) {
        const result = parseDisplay(display);
        if (typeof result === 'string') return badRequest(reply, result);
        parsedDisplay = result;
      }
      const updated = tenant.updateWall(request.params.id, {
        ...(typeof name === 'string' ? { name } : {}),
        ...(parsedDisplay ? { display: parsedDisplay } : {}),
        ...(mode !== undefined ? { moderationMode: mode } : {}),
        ...(keywordApproval !== undefined ? { keywordRequireApproval: keywordApproval } : {}),
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
      if (requireRole(request, reply, tenant, 'owner')) return;
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
        `${wall.id}: ${applied
          .map((t) => `${t.type}:${t.value}${t.requireApproval === 'inherit' ? '' : `(${t.requireApproval})`}`)
          .join(',')}`,
        request,
        undefined,
        sessions
      );
      return reply.send({ terms: applied });
    }
  );

  // ---- テナント設定 ----

  /**
   * テナント共通の設定を変更する。
   * 会場モニターの見た目に関わる設定はテナント単位なので、ここで扱う
   * (ウォール単位の設定は PATCH /api/admin/walls/:id)。
   */
  app.patch<{
    Body: {
      title?: unknown;
      subtitle?: unknown;
      showBlueskyLogo?: unknown;
      animateTitleGradient?: unknown;
      backfillPresets?: unknown;
      allowReplies?: unknown;
      filterLabeled?: unknown;
      ngWords?: unknown;
      ngPatterns?: unknown;
    };
  }>('/api/admin/settings', async (request, reply) => {
    const tenant = getTenant(request);
    // テナント全体の設定変更にあたるため owner 限定。
    if (requireRole(request, reply, tenant, 'owner')) return;
    const body = request.body ?? {};
    const patch: Partial<TenantSettings> = {};
    const changed: string[] = [];

    for (const key of ['title', 'subtitle'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > 200) {
        return badRequest(reply, `${key} は 200 文字までの文字列で指定してください`);
      }
      patch[key] = value.trim();
      changed.push(key);
    }

    for (const key of [
      'showBlueskyLogo',
      'animateTitleGradient',
      'allowReplies',
      'filterLabeled',
    ] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') return badRequest(reply, `${key} は boolean で指定してください`);
      patch[key] = value;
      changed.push(`${key}=${value}`);
    }

    if (body.backfillPresets !== undefined) {
      if (!Array.isArray(body.backfillPresets)) {
        return badRequest(reply, 'backfillPresets は配列で指定してください');
      }
      const presets: number[] = [];
      for (const entry of body.backfillPresets) {
        const n = typeof entry === 'number' ? entry : Number.parseInt(String(entry), 10);
        if (!Number.isFinite(n) || n < 1 || n > 2160) {
          return badRequest(reply, '取り込みの候補は 1 〜 2160 分で指定してください');
        }
        if (!presets.includes(Math.floor(n))) presets.push(Math.floor(n));
      }
      if (presets.length > 20) return badRequest(reply, '取り込みの候補は 20 件までです');
      presets.sort((a, b) => a - b);
      patch.backfillPresets = presets;
      changed.push(`backfillPresets=${presets.length}`);
    }

    for (const key of ['ngWords', 'ngPatterns'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) return badRequest(reply, `${key} は配列で指定してください`);
      if (value.length > 200) return badRequest(reply, `${key} は 200 件までです`);
      const words: string[] = [];
      for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          return badRequest(reply, `${key} の要素は空でない文字列で指定してください`);
        }
        const normalized = key === 'ngWords' ? entry.trim().toLowerCase() : entry.trim();
        if (!words.includes(normalized)) words.push(normalized);
      }
      if (key === 'ngPatterns') {
        // 壊れた正規表現を保存すると受信のたびに落ちる。ここで弾く。
        for (const source of words) {
          try {
            new RegExp(source);
          } catch {
            return badRequest(reply, `正規表現として解釈できません: ${source}`);
          }
        }
      }
      patch[key] = words;
      // 語そのものは監査ログに残さない。件数だけ記録する。
      changed.push(`${key}=${words.length}`);
    }

    if (changed.length === 0) return badRequest(reply, '変更する設定がありません');

    tenant.updateSettings(patch);
    recordAudit('settings', changed.join(' '), request, undefined, sessions);
    return reply.send({ settings: tenant.getTenant().settings });
  });

  // ---- 画面モード (会場モニターの待機・休憩・終演) ----

  /** 画像の上限。会場モニターに出す QR や案内を想定した大きさ。 */
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

  const SCREEN_TEXT_KEYS = [
    'waitingHeadline',
    'waitingHint',
    'breakHeadline',
    'breakNote',
    'endedHeadline',
    'endedNote',
    'imageCaption',
  ] as const;

  /** 画面モードの入力を検証する。問題があればエラーメッセージ (文字列) を返す。 */
  function parseScreen(raw: unknown): Partial<WallScreen> | string {
    if (typeof raw !== 'object' || raw === null) return 'screen はオブジェクトで指定してください';
    const input = raw as Record<string, unknown>;
    const out: Partial<WallScreen> = {};

    if (input.mode !== undefined) {
      const modes: ScreenMode[] = ['wall', 'waiting', 'break', 'ended'];
      if (!modes.includes(input.mode as ScreenMode)) {
        return "mode は 'wall' / 'waiting' / 'break' / 'ended' のいずれかです";
      }
      out.mode = input.mode as ScreenMode;
    }

    for (const key of SCREEN_TEXT_KEYS) {
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > 120) {
        return `${key} は 120 文字までの文字列で指定してください`;
      }
      out[key] = value;
    }

    for (const key of ['autoResume', 'showImage'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') return `${key} は boolean で指定してください`;
      out[key] = value;
    }

    if (input.imagePosition !== undefined) {
      const positions: ScreenImagePosition[] = ['bottom-right', 'bottom-center', 'bottom-left', 'center'];
      if (!positions.includes(input.imagePosition as ScreenImagePosition)) {
        return 'imagePosition が不正です';
      }
      out.imagePosition = input.imagePosition as ScreenImagePosition;
    }

    if (input.imageSize !== undefined) {
      const sizes: ScreenImageSize[] = ['small', 'medium', 'large'];
      if (!sizes.includes(input.imageSize as ScreenImageSize)) return 'imageSize が不正です';
      out.imageSize = input.imageSize as ScreenImageSize;
    }

    return out;
  }

  app.get<{ Querystring: { wall?: string } }>('/api/admin/screen', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const wall = pickWall(tenant, request.query.wall);
    if (!wall) return wallNotFound(reply);
    return reply.send(wall.getScreen());
  });

  /**
   * 画面モードと文言を更新する。
   * 会場の進行に合わせて切り替えるものなので、モデレーターも変更できる。
   */
  app.post<{ Body: { wall?: unknown; screen?: unknown } }>('/api/admin/screen', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const wall = pickWall(tenant, request.body?.wall);
    if (!wall) return wallNotFound(reply);

    const parsed = parseScreen(request.body?.screen);
    if (typeof parsed === 'string') return badRequest(reply, parsed);
    if (Object.keys(parsed).length === 0) return badRequest(reply, '変更する設定がありません');

    // 進行に合わせたモードの切り替えは現場の仕事なのでモデレーターも行える。
    // 文言や画像の設定はイベントの作り込みなので owner に限る。
    const onlyMode = Object.keys(parsed).every((key) => key === 'mode');
    if (!onlyMode && requireRole(request, reply, tenant, 'owner')) return;

    const applied = wall.setScreen(parsed);
    recordAudit(
      'screen',
      `${wall.id}: ${parsed.mode ? 'mode=' + parsed.mode : Object.keys(parsed).join(',')}`,
      request,
      undefined,
      sessions
    );
    return reply.send(applied);
  });

  /** 任意画像 (QR など) を差し替える。base64 で受け取り、ファイルとして保存する。 */
  app.post<{ Body: { wall?: unknown; mime?: unknown; data?: unknown } }>(
    '/api/admin/screen/image',
    async (request, reply) => {
      const tenant = getTenant(request);
      if (requireRole(request, reply, tenant, 'owner')) return;
      const wall = pickWall(tenant, request.body?.wall);
      if (!wall) return wallNotFound(reply);

      const { mime, data } = request.body ?? {};
      if (typeof mime !== 'string' || !IMAGE_EXTENSIONS[mime]) {
        return badRequest(reply, '画像は PNG / JPEG / WebP で指定してください');
      }
      if (typeof data !== 'string' || data === '') {
        return badRequest(reply, 'data は base64 の文字列で指定してください');
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(data, 'base64');
      } catch {
        return badRequest(reply, '画像を読み取れませんでした');
      }
      if (bytes.length === 0) return badRequest(reply, '画像を読み取れませんでした');
      if (bytes.length > MAX_IMAGE_BYTES) return badRequest(reply, '画像は 2 MB までです');

      const previousKey = wall.getScreenImageKey();
      let stored;
      try {
        stored = await images.put(bytes, mime);
      } catch (err) {
        logger.warn('画像を保存できませんでした', err);
        return reply.code(500).send({ error: 'write_failed', message: '画像を保存できませんでした' });
      }

      const applied = wall.setScreenImage({ file: stored.key, mime, updatedAt: Date.now() });
      // 古い画像は置いていても使われないので消す。失敗は無視 (表示には影響しない)。
      if (previousKey) await images.remove(previousKey);
      recordAudit('screen-image', `${wall.id}: ${bytes.length} bytes`, request, undefined, sessions);
      return reply.send(applied);
    }
  );

  app.delete<{ Querystring: { wall?: string } }>('/api/admin/screen/image', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'owner')) return;
    const wall = pickWall(tenant, request.query.wall);
    if (!wall) return wallNotFound(reply);

    const previousKey = wall.getScreenImageKey();
    const applied = wall.setScreenImage(null);
    if (previousKey) await images.remove(previousKey);
    recordAudit('screen-image', `${wall.id}: 削除`, request, undefined, sessions);
    return reply.send(applied);
  });

  // ---- 除外キーワード ----

  app.get<{ Querystring: { wall?: string } }>('/api/admin/exclude', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'moderator')) return;
    const wall = pickWall(tenant, request.query.wall);
    if (!wall) return wallNotFound(reply);
    return reply.send(wall.getExcludes());
  });

  /**
   * 除外キーワードと、その扱いをまとめて差し替える。
   * 監視語と同じくモデレーターが変更できる (会場の空気に合わせて即座に足せるように)。
   */
  app.post<{ Body: { terms?: unknown; policy?: unknown; wall?: unknown } }>(
    '/api/admin/exclude',
    async (request, reply) => {
      const tenant = getTenant(request);
      if (requireRole(request, reply, tenant, 'owner')) return;
      const wall = pickWall(tenant, request.body?.wall);
      if (!wall) return wallNotFound(reply);
      const { terms, policy } = request.body ?? {};

      let parsed: { value: string }[] | undefined;
      if (terms !== undefined) {
        if (!Array.isArray(terms)) return badRequest(reply, 'terms は配列で指定してください');
        const result = parseExcludeTerms(terms);
        if (typeof result === 'string') return badRequest(reply, result);
        parsed = result;
      }
      if (policy !== undefined && policy !== 'reject' && policy !== 'approve') {
        return badRequest(reply, "policy は 'reject' か 'approve' で指定してください");
      }

      const applied = wall.setExcludes({
        ...(parsed ? { terms: parsed } : {}),
        ...(policy === 'reject' || policy === 'approve' ? { policy } : {}),
      });
      // 監査ログには語そのものを残さない。件数と扱いだけで足りる。
      recordAudit(
        'exclude-terms',
        `${wall.id}: ${applied.terms.length} 件 / ${applied.policy}`,
        request,
        undefined,
        sessions
      );
      return reply.send(applied);
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
    // multi モードではテナント側からの切り替えを一律禁止し、システム管理 API
    // (`/api/admin/system/jetstream`) に集約する。single モードでは
    // テナントが 1 つしかなく影響範囲が自分自身に限られるため、従来どおり owner に許す。
    if (config.tenancy.mode === 'multi') {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'マルチテナント運用では接続先の切り替えはシステム管理者のみ実行できます',
      });
    }
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
      if (requireRole(request, reply, tenant, 'owner')) return;
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
    if (requireRole(request, reply, tenant, 'owner')) return;
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
    if (requireRole(request, reply, tenant, 'owner')) return;
    const { uri } = request.body ?? {};
    if (typeof uri !== 'string' || uri === '') {
      return badRequest(reply, 'uri は空でない文字列で指定してください');
    }
    recordAudit('modlist-unsubscribe', uri, request, undefined, sessions);
    return reply.send({ ok: tenant.unsubscribeModList(uri) });
  });

  app.post<{ Body: { wall?: unknown } }>('/api/admin/clear', async (request, reply) => {
    const tenant = getTenant(request);
    if (requireRole(request, reply, tenant, 'owner')) return;
    const wall = pickWall(tenant, request.body?.wall);
    if (!wall) return wallNotFound(reply);
    recordAudit('clear', wall.id, request, undefined, sessions);
    wall.clear();
    return reply.send({ ok: true });
  });

  // ---- メンバー管理 (owner とシステム管理者のみ。single モードには概念が無い) ----


  app.get('/api/admin/members', async (request, reply) => {
    const tenant = getTenant(request);
    if (config.tenancy.mode !== 'multi') {
      return badRequest(reply, '単一テナント運用ではメンバー管理を使いません');
    }
    if (requireRole(request, reply, tenant, 'owner')) return;
    return reply.send({ members: tenant.listMembers() });
  });

  app.post<{ Body: { actor?: unknown; role?: unknown } }>(
    '/api/admin/members',
    async (request, reply) => {
      const tenant = getTenant(request);
      if (config.tenancy.mode !== 'multi') {
        return badRequest(reply, '単一テナント運用ではメンバー管理を使いません');
      }
      if (requireRole(request, reply, tenant, 'owner')) return;
      const { actor, role } = request.body ?? {};
      if (typeof actor !== 'string' || actor.trim() === '') {
        return badRequest(reply, 'actor は空でない文字列で指定してください');
      }
      if (role !== 'owner' && role !== 'moderator') {
        return badRequest(reply, "role は 'owner' か 'moderator' で指定してください");
      }
      // actor はハンドルまたは DID。ハンドルは変更され得るため、保存前に DID へ解決する。
      const resolved = await resolveActor(config, actor);
      if (!resolved) {
        return badRequest(reply, `アカウントを解決できませんでした: ${actor}`);
      }
      try {
        const member = tenant.addMember({ did: resolved.did, handle: resolved.handle, role });
        recordAudit('member-add', `${member.handle} (${member.role})`, request, undefined, sessions);
        return reply.send({ member });
      } catch (err) {
        return badRequest(reply, err instanceof Error ? err.message : 'メンバーを追加できません');
      }
    }
  );

  app.patch<{ Params: { did: string }; Body: { role?: unknown } }>(
    '/api/admin/members/:did',
    async (request, reply) => {
      const tenant = getTenant(request);
      if (config.tenancy.mode !== 'multi') {
        return badRequest(reply, '単一テナント運用ではメンバー管理を使いません');
      }
      if (requireRole(request, reply, tenant, 'owner')) return;
      const { role } = request.body ?? {};
      if (role !== 'owner' && role !== 'moderator') {
        return badRequest(reply, "role は 'owner' か 'moderator' で指定してください");
      }
      try {
        // 自分自身を降格させることも、owner が 0 人にならない限り許可する。
        const member = tenant.updateMemberRole(request.params.did, role);
        if (!member) {
          return reply.code(404).send({ error: 'member_not_found' });
        }
        recordAudit('member-update', `${member.handle} -> ${member.role}`, request, undefined, sessions);
        return reply.send({ member });
      } catch (err) {
        return badRequest(reply, err instanceof Error ? err.message : '役割を変更できません');
      }
    }
  );

  app.delete<{ Params: { did: string } }>('/api/admin/members/:did', async (request, reply) => {
    const tenant = getTenant(request);
    if (config.tenancy.mode !== 'multi') {
      return badRequest(reply, '単一テナント運用ではメンバー管理を使いません');
    }
    if (requireRole(request, reply, tenant, 'owner')) return;
    try {
      const ok = tenant.removeMember(request.params.did);
      if (ok) recordAudit('member-remove', request.params.did, request, undefined, sessions);
      return reply.send({ ok });
    } catch (err) {
      return badRequest(reply, err instanceof Error ? err.message : 'メンバーを削除できません');
    }
  });
}
