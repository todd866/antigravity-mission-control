import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');
mkdirSync(distDir, { recursive: true });

const jsResult = await build({
  entryPoints: [join(__dirname, 'src', 'app.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  write: false,
});

const css = readFileSync(join(__dirname, 'src', 'app.css'), 'utf8');
const js = jsResult.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;

const outHtmlPath = join(distDir, 'app.html');
writeFileSync(outHtmlPath, html, 'utf8');
console.log(`Built ${outHtmlPath} (${Buffer.byteLength(html, 'utf8')} bytes)`);

const outServerPath = join(distDir, 'server.mjs');
await build({
  entryPoints: [join(__dirname, 'server.mjs')],
  outfile: outServerPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  external: ['node:*'],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
console.log(`Built ${outServerPath}`);
