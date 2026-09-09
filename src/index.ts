/**
 * エントリポイント。
 * ingest (Jetstream 受信) と server (HTTP/SSE) を組み立てて起動する。
 */
import { loadConfig } from './shared/config.js';
import { createLogger, setLogLevel } from './shared/logger.js';
import { createWallSource } from './ingest/index.js';
import { createServer } from './server/index.js';

const config = loadConfig();
setLogLevel(config.server.logLevel);
const log = createLogger('main');

async function main(): Promise<void> {
  // 監視語が未設定でも起動する。キーワードだけの運用や、
  // 起動してから管理画面で設定する運用を妨げないため。
  if (config.event.terms.length === 0) {
    log.warn('監視語が未設定です。管理画面から設定するまで投稿は拾われません。');
  }

  // トークン方式が有効なときだけ、トークンに関する検証を行う。
  // AUTH_MODE=oauth ではトークンを使わないため、未設定でも正常な構成。
  const tokenAuthEnabled =
    config.admin.authMode === 'token' || config.admin.authMode === 'both';

  // リバースプロキシ配下では loopback 例外が使えないため、トークンなしでの起動を拒否する。
  // これを許すと、プロキシ経由の全アクセスが管理者権限を得てしまう。
  if (tokenAuthEnabled && config.server.trustProxy && config.admin.token === '') {
    log.error(
      'TRUST_PROXY=true では ADMIN_TOKEN が必須です。' +
        '設定しないと、プロキシ経由のすべてのアクセスが管理 API を操作できてしまいます。'
    );
    process.exit(1);
  }

  // リモート公開時に短いトークンを許すと総当たりで破られる。
  const MIN_TOKEN_LENGTH = 24;
  if (tokenAuthEnabled && config.server.trustProxy && config.admin.token.length < MIN_TOKEN_LENGTH) {
    log.error(
      `ADMIN_TOKEN が短すぎます (${config.admin.token.length} 文字)。` +
        `リモート公開時は ${MIN_TOKEN_LENGTH} 文字以上にしてください。` +
        '生成例: openssl rand -hex 32'
    );
    process.exit(1);
  }
  if (
    tokenAuthEnabled &&
    !config.server.trustProxy &&
    config.admin.token !== '' &&
    config.admin.token.length < MIN_TOKEN_LENGTH
  ) {
    log.warn(
      `ADMIN_TOKEN が短めです (${config.admin.token.length} 文字)。` +
        'リモートから使う場合は openssl rand -hex 32 で生成し直してください。'
    );
  }

  // 共有サービスとして動かす場合の必須条件を検証する。
  if (config.tenancy.mode === 'multi') {
    if (config.admin.authMode !== 'oauth') {
      log.error(
        'MULTI_TENANT=true では AUTH_MODE=oauth が必須です。' +
          '共有トークン 1 個を全テナントで使う構成は成立しません ' +
          '(誰がどのテナントの管理者かを区別できないため)。'
      );
      process.exit(1);
    }
    log.warn(
      'マルチテナントモードは実装途中です。' +
        'テナントの永続化層まで実装済みで、テナントごとのウォール管理は未対応です。' +
        '本番運用にはまだ使わないでください。'
    );
  }

  // OAuth を使う場合の必須設定を起動時に検証する。
  if (config.admin.authMode === 'oauth' || config.admin.authMode === 'both') {
    if (config.oauth.publicUrl === '') {
      log.error('AUTH_MODE に oauth を指定した場合、PUBLIC_URL が必須です (例: https://wall.example.com)');
      process.exit(1);
    }
    if (!/^https:\/\//.test(config.oauth.publicUrl) && !config.oauth.allowHttp) {
      log.error(
        'PUBLIC_URL は https である必要があります。' +
          'localhost での開発時のみ OAUTH_ALLOW_HTTP=true で回避できます。'
      );
      process.exit(1);
    }
    if (config.admin.allowedActors.length === 0) {
      log.error(
        'AUTH_MODE に oauth を指定した場合、ADMIN_ACTORS が必須です。' +
          '空のままでは誰もログインできません (例: ADMIN_ACTORS=alice.bsky.social)'
      );
      process.exit(1);
    }
  }

  const source = createWallSource(config);
  const server = await createServer(config, source);

  // Jetstream への接続は HTTP リスンより先に開始する。
  // 起動直後にモニターを開いても取りこぼしが起きないようにするため。
  await source.start();
  await server.listen({ port: config.server.port, host: config.server.host });

  log.info('起動しました', {
    url: `http://localhost:${config.server.port}/wall`,
    admin: `http://localhost:${config.server.port}/admin`,
    hashtags: config.event.hashtags.map((t) => `#${t}`),
    moderation: config.moderation.mode,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} を受信。終了処理を開始します。`);
    // 猶予時間を過ぎたら強制終了する (SSE 接続が閉じ切らないケースへの保険)。
    const force = setTimeout(() => process.exit(1), 5_000);
    force.unref();
    try {
      await source.stop();
      await server.close();
    } catch (err) {
      log.error('終了処理でエラーが発生しました', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 予期しない例外でプロセスを落とさない。イベント中の停止が最大のリスクのため。
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
  });
}

main().catch((err: unknown) => {
  log.error('起動に失敗しました', err);
  process.exit(1);
});
