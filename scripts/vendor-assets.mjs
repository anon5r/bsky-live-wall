/**
 * 外部依存をローカルへ取り込む。
 *
 * 会場のネットワークが不安定でも確実に表示させるため、CDN を参照しない。
 * node_modules から必要なファイルだけを public/vendor/ へ複製する。
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

// ---- Lit とその実行時依存 (Web Awesome の各コンポーネントが内部で bare import する) ----
//
// public/vendor/webawesome/components|chunks の中身は `import ... from "lit"` のような
// 裸のパッケージ指定子を使っている。ブラウザはこれを解決できないため、実体を
// ローカルへ複製したうえで、管理画面側 (index.html) の importmap で
// 「パッケージ名 -> ここに複製したファイル」を対応づける必要がある。
// バージョンが変わってもパスがずれないよう、pnpm のハッシュ付きパスを
// 直接書かずに import.meta.resolve でパッケージの実体を解決する。
{
  const dest = join(vendor, 'lit');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  // lit 等はこのリポジトリの直接の依存ではなく、@awesome.me/webawesome の
  // 依存として node_modules にインストールされている。pnpm は依存を
  // フラットに展開しないため、リポジトリ直下から import.meta.resolve('lit')
  // としても見つからない。@awesome.me/webawesome の実体 (シンボリックリンク先)
  // を起点に require.resolve することで、その依存関係の中から解決する。
  const webawesomeEntry = await realpath(
    join(root, 'node_modules', '@awesome.me', 'webawesome', 'dist', 'webawesome.js')
  );
  const requireFromWebawesome = createRequire(webawesomeEntry);
  // "./package.json" が exports に定義されていないパッケージもあるため、
  // 実際に読み込まれるファイルから package.json が見つかるまで親を辿る。
  const packageRoot = async (specifier) => {
    let dir = dirname(requireFromWebawesome.resolve(specifier));
    while (!existsSync(join(dir, 'package.json'))) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`${specifier} の package.json が見つかりません`);
      dir = parent;
    }
    return dir;
  };

  // lit / lit-html / lit-element / @lit/reactive-element はパッケージ内の
  // サブパス (例: "lit/decorators.js") がそのままファイル名と一致しているため、
  // ディレクトリごと複製すれば importmap の「フォルダ対応」だけで解決できる。
  const wholePackages = [
    ['lit', 'lit'],
    ['lit-html', 'lit-html'],
    ['lit-element', 'lit-element'],
    ['@lit/reactive-element', 'reactive-element'],
  ];
  // 実行時に必要なのは .js だけ。ソースマップと型定義が容量の大半を占める
  // (含めると約 6MB、除くと約 0.4MB) ため複製しない。
  const runtimeOnly = (src) => {
    const name = src.toLowerCase();
    if (name.endsWith('.map') || name.endsWith('.d.ts') || name.endsWith('.md')) return false;
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) return false;
    return true;
  };

  for (const [pkg, dirName] of wholePackages) {
    const from = await packageRoot(pkg);
    const to = join(dest, dirName);
    await cp(from, to, { recursive: true, filter: runtimeOnly });
  }

  // @floating-ui/* と関連パッケージは ESM のビルド成果物 (dist/*.esm.js) だけを
  // 決まったファイル名で置く。パッケージ丸ごとの複製は不要。
  const singleFiles = [
    ['@floating-ui/dom', 'dist/floating-ui.dom.esm.js', 'floating-ui-dom.esm.js'],
    ['@floating-ui/core', 'dist/floating-ui.core.esm.js', 'floating-ui-core.esm.js'],
    ['@floating-ui/utils', 'dist/floating-ui.utils.esm.js', 'floating-ui-utils.esm.js'],
    ['@floating-ui/utils', 'dist/floating-ui.utils.dom.esm.js', 'floating-ui-utils-dom.esm.js'],
    ['@shoelace-style/localize', 'dist/index.js', 'shoelace-localize.js'],
    ['composed-offset-position', 'dist/composed-offset-position.mjs', 'composed-offset-position.mjs'],
  ];
  for (const [pkg, relPath, outName] of singleFiles) {
    const from = join(await packageRoot(pkg), relPath);
    await cp(from, join(dest, outName));
  }

  console.log(`Lit 関連の実行時依存を ${dest} へ複製しました`);
}
