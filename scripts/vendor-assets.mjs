/**
 * 外部依存をローカルへ取り込む。
 *
 * 会場のネットワークが不安定でも確実に表示させるため、CDN を参照しない。
 * node_modules から必要なファイルだけを public/vendor/ へ複製する。
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');

// ---- Font Awesome (アイコン) ----
{
  const src = join(root, 'node_modules', '@fortawesome', 'fontawesome-free');
  const dest = join(vendor, 'fontawesome');
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(dest, 'css'), { recursive: true });
  await cp(join(src, 'css', 'all.min.css'), join(dest, 'css', 'all.min.css'));
  await cp(join(src, 'webfonts'), join(dest, 'webfonts'), { recursive: true });
  console.log(`Font Awesome を ${dest} へ複製しました`);
}

// ---- Web Awesome (管理画面の UI コンポーネント) ----
{
  const src = join(root, 'node_modules', '@awesome.me', 'webawesome', 'dist');
  const dest = join(vendor, 'webawesome');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  // components は chunks を相対参照するため、この 2 つは必ず対で置く。
  // types / react / skills など配布物の大半は実行時に不要なので複製しない。
  for (const dir of ['styles', 'chunks', 'components']) {
    await cp(join(src, dir), join(dest, dir), { recursive: true });
  }
  console.log(`Web Awesome を ${dest} へ複製しました`);
}
