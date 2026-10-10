// Builds dist/: tsc emits the Node code, and esbuild bundles the viewer's client into one script
// that is inlined, with the template's markup and CSS, into dist/viewer/viewer.html.
//
//   node scripts/build.ts

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');

/** Where the bundled client goes in the template. */
const CLIENT_MARKER = '<!-- @viewer-client -->';
/** What renderHtml replaces with the view data; it must occur once, in the data script. */
const DATA_PLACEHOLDER = '"__TRACE_DATA__"';

rmSync(dist, { recursive: true, force: true });

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const compiled = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
chmodSync(join(dist, 'cli', 'main.js'), 0o755);

const bundle = await build({
  entryPoints: [join(root, 'src', 'viewer', 'client', 'main.ts')],
  tsconfig: join(root, 'src', 'viewer', 'client', 'tsconfig.json'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
});
const script = bundle.outputFiles[0]?.text;
if (script === undefined) throw new Error('esbuild wrote no bundle for the viewer client');
// Inside <script>, only "</script" ends the block and "<!--" changes how it is parsed.
if (/<\/script|<!--/i.test(script)) throw new Error('the viewer client bundle holds "</script" or "<!--"');
if (script.includes('__TRACE_DATA__')) throw new Error('the viewer client bundle holds the data placeholder');

const template = readFileSync(join(root, 'src', 'viewer', 'template.html'), 'utf8');
const count = (s: string, part: string): number => s.split(part).length - 1;
if (count(template, CLIENT_MARKER) !== 1) throw new Error(`the viewer template needs ${CLIENT_MARKER} once`);
if (count(template, DATA_PLACEHOLDER) !== 1) throw new Error(`the viewer template needs ${DATA_PLACEHOLDER} once`);
// A replacer function, so that "$" sequences in the bundle are not read as patterns.
const html = template.replace(CLIENT_MARKER, () => `<script>\n${script}</script>`);

mkdirSync(join(dist, 'viewer'), { recursive: true });
writeFileSync(join(dist, 'viewer', 'viewer.html'), html);
