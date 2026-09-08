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
  if (config.event.normalizedHashtags.length === 0) {
    log.error('HASHTAGS が空です。.env に監視するハッシュタグを設定してください。');
    process.exit(1);
  }

  // リバースプロキシ配下では loopback 例外が使えないため、トークンなしでの起動を拒否する。
  // これを許すと、プロキシ経由の全アクセスが管理者権限を得てしまう。
  if (config.server.trustProxy && config.admin.token === '') {
    log.error(
      'TRUST_PROXY=true では ADMIN_TOKEN が必須です。' +
        '設定しないと、プロキシ経由のすべてのアクセスが管理 API を操作できてしまいます。'
    );
    process.exit(1);
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
