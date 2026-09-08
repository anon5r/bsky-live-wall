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
const src = join(root, 'node_modules', '@fortawesome', 'fontawesome-free');
const dest = join(root, 'public', 'vendor', 'fontawesome');

await rm(dest, { recursive: true, force: true });
await mkdir(join(dest, 'css'), { recursive: true });
await cp(join(src, 'css', 'all.min.css'), join(dest, 'css', 'all.min.css'));
await cp(join(src, 'webfonts'), join(dest, 'webfonts'), { recursive: true });

console.log(`Font Awesome を ${dest} へ複製しました`);
