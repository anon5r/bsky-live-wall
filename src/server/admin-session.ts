/**
 * 管理画面のセッション管理。
 *
 * トークンを毎回送る方式をやめ、ログイン時に一度だけトークンを検証して
 * セッションを発行する。セッション ID は HttpOnly Cookie で渡すため、
 * ブラウザの JavaScript からは読み取れず、localStorage にも残らない。
 *
 * これにより次の弱点を解消する。
 * - 失効できない        -> セッション単位・全体の失効ができる
 * - 有効期限がない      -> TTL を過ぎたセッションは自動的に無効になる
 * - 誰の操作か分からない -> セッション ID で操作を紐付けられる
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'wall_admin_session';

export interface AdminSession {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** 発行時のクライアント IP。監査用 */
  ip: string;
  /** 発行時の User-Agent (先頭のみ)。監査用 */
  userAgent: string;
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSession>();
  private readonly ttlMs: number;

  constructor(ttlHours: number) {
    this.ttlMs = Math.max(1, ttlHours) * 3_600_000;
  }

  create(ip: string, userAgent: string): AdminSession {
    this.pruneExpired();
    const now = Date.now();
    const session: AdminSession = {
      id: randomBytes(32).toString('base64url'),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      ip,
      userAgent: userAgent.slice(0, 120),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** セッションを検証する。期限切れは破棄して null を返す。 */
  verify(id: string | undefined): AdminSession | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  revoke(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** 全セッションを失効させる。トークン漏洩時の緊急手段。 */
  revokeAll(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  list(): AdminSession[] {
    this.pruneExpired();
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

/** Cookie ヘッダから 1 つの値を取り出す。依存を増やさないため自前で解析する。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** 長さの違いを漏らさずに文字列を比較する。 */
export function safeEqual(input: string, expected: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
