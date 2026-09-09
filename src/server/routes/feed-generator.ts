/**
 * AT Protocol カスタムフィードジェネレータ (任意機能, FR-24)。
 * `config.feedGenerator.enabled` が true のときのみ呼び出し元で登録される。
 * JWT 検証は行わない (公開フィードとして提供)。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import type { WallSource } from '../../shared/contracts.js';
import type { WallPost } from '../../shared/types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

/** カーソルは receivedAt (epoch ms) の文字列表現。 */
function parseCursor(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function registerFeedGeneratorRoutes(
  app: FastifyInstance,
  config: AppConfig,
  source: WallSource,
): void {
  const { hostname, rkey, publisherDid } = config.feedGenerator;
  const feedUri = `at://${publisherDid}/app.bsky.feed.generator/${rkey}`;
  const did = `did:web:${hostname}`;

  app.get<{ Querystring: { feed?: string; limit?: string; cursor?: string } }>(
    '/xrpc/app.bsky.feed.getFeedSkeleton',
    async (request, reply) => {
      const limit = clampLimit(request.query.limit);
      const cursorTime = parseCursor(request.query.cursor);

      // 直近投稿を新しい順で取得し、cursor より古いものだけに絞る。
      const all = source.getDefaultWall().getRecent(config.buffer.size);
      const filtered = cursorTime === null ? all : all.filter((p: WallPost) => p.receivedAt < cursorTime);
      const page = filtered.slice(0, limit);

      const feed = page.map((p: WallPost) => ({ post: p.uri }));
      const last = page[page.length - 1];
      const nextCursor = page.length === limit && last ? String(last.receivedAt) : undefined;

      return reply.send(nextCursor ? { feed, cursor: nextCursor } : { feed });
    },
  );

  app.get('/xrpc/app.bsky.feed.describeFeedGenerator', async (_request, reply) => {
    return reply.send({ did, feeds: [{ uri: feedUri }] });
  });

  app.get('/.well-known/did.json', async (_request, reply) => {
    return reply.send({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      service: [
        {
          id: '#bsky_fg',
          type: 'BskyFeedGenerator',
          serviceEndpoint: `https://${hostname}`,
        },
      ],
    });
  });
}
