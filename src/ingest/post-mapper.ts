/**
 * Jetstream イベント + レコードを WallPost へ変換する。
 */
import type { BlobRef, BskyPostRecord, WallAuthor, WallImage, WallPost } from '../shared/types.js';

const MAX_TEXT_LENGTH = 1000;
const MAX_IMAGES = 4;

/** 制御文字を除去し、長すぎる場合は切り詰める。 */
function sanitizeText(text: string | undefined): string {
  if (!text) return '';
  // C0/C1 制御文字 (改行 \n は許可) を除去する。
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  if (cleaned.length <= MAX_TEXT_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_TEXT_LENGTH)}…`;
}

function blobCid(ref: BlobRef | undefined): string | null {
  if (!ref?.ref) return null;
  if (typeof ref.ref === 'string') return ref.ref;
  return ref.ref.$link ?? null;
}

/** embed から画像 URL 群を組み立てる。images / recordWithMedia(media 側) に対応。 */
function extractImages(record: BskyPostRecord, did: string, showImages: boolean): WallImage[] {
  if (!showImages) return [];
  const embed = record.embed;
  if (!embed) return [];

  let images = embed.images;
  if (!images && embed.$type === 'app.bsky.embed.recordWithMedia' && embed.media?.images) {
    images = embed.media.images;
  }
  if (!images || images.length === 0) return [];

  const out: WallImage[] = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    const cid = blobCid(img.image);
    if (!cid) continue;
    out.push({
      thumb: `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${cid}@jpeg`,
      fullsize: `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`,
      alt: img.alt ?? '',
      ...(img.aspectRatio ? { aspectRatio: img.aspectRatio } : {}),
    });
  }
  return out;
}

export interface MapPostInput {
  did: string;
  rkey: string;
  cid: string;
  record: BskyPostRecord;
  timeUs: number;
  matchedTags: string[];
  matchedKeywords: string[];
  showImages: boolean;
  /** 未解決の場合は did/handle のみのプレースホルダを渡す。 */
  author: WallAuthor;
}

export function mapToWallPost(input: MapPostInput): WallPost {
  const { did, rkey, cid, record, timeUs, matchedTags, matchedKeywords, showImages, author } = input;
  const receivedAt = Date.now();

  let createdAt = record.createdAt;
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    createdAt = new Date(receivedAt).toISOString();
  }

  return {
    uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    cid,
    rkey,
    did,
    author,
    text: sanitizeText(record.text),
    matchedTags,
    matchedKeywords,
    images: extractImages(record, did, showImages),
    langs: record.langs ?? [],
    isReply: record.reply !== undefined,
    createdAt,
    receivedAt,
    timeUs,
    webUrl: `https://bsky.app/profile/${did}/post/${rkey}`,
    status: 'visible',
  };
}
