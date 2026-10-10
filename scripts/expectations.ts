// Writes what the prototype prints for the synthetic Claude Code fixtures into
// test/fixtures/claude-code/expected/, which test/report-fixtures.test.ts compares the CLI with,
// byte for byte, and the view data its HTML embeds for each transcript into expected/view/, which
// test/view-fixtures.test.ts compares the CLI's html with. Run it when a fixture or a case changes:
//
//   node scripts/expectations.ts
//
// The prototype is REFERENCE_TRACE, by default local/reference/trace.mjs (see scripts/parity.ts).
// Clock times are local; the cases are written in Europe/Paris, the zone the tests run in.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const reference = resolve(process.env['REFERENCE_TRACE'] ?? join(root, 'local', 'reference', 'trace.mjs'));
const store = join(root, 'test', 'fixtures', 'claude-code', 'store');
const out = join(root, 'test', 'fixtures', 'claude-code', 'expected');

/** A case: the file its output goes to, and the CLI's arguments (without --store). */
interface Case {
  readonly file: string;
  readonly command: readonly string[];
}

const transcripts = {
  badge: '5e1f',
  'old-format': '5e9b',
  compaction: 'c3d4',
  'agent-review': 'a1b2',
  'agent-nested': 'a9f8',
  'agent-plan': 'ab12',
  'agent-write': 'ac98',
};

const cases: Case[] = [
  { file: 'list.txt', command: ['list'] },
  ...Object.entries(transcripts).flatMap(([name, ref]) => [
    { file: `${name}.txt`, command: ['report', ref] },
    { file: `${name}.timeline.txt`, command: ['report', ref, '--timeline'] },
  ]),
  { file: 'badge.turn-2.txt', command: ['report', '5e1f', '--timeline', '--turn', '2'] },
  { file: 'badge.turn-9.txt', command: ['report', '5e1f', '--timeline', '--turn', '9'] },
  { file: 'badge.top-3.no-subagents.txt', command: ['report', '5e1f', '--top', '3', '--no-subagents'] },
  { file: 'badge.top-0.txt', command: ['report', '5e1f', '--top', '0'] },
  { file: 'badge.min-idle-600.txt', command: ['report', '5e1f', '--timeline', '--min-idle', '600'] },
  { file: 'badge.min-idle-0.5.txt', command: ['report', '5e1f', '--timeline', '--min-idle', '0.5'] },
];

/** The prototype's arguments for the CLI's: `--list` for `list`, the session and flags for `report`. */
function prototypeArgs([command, ...rest]: readonly string[]): string[] {
  return command === 'list' ? ['--list', ...rest] : rest;
}

if (!existsSync(reference)) {
  console.error(`expectations: no prototype at ${reference}; set REFERENCE_TRACE or link local/reference/trace.mjs.`);
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const c of cases) {
  const stdout = execFileSync(process.execPath, [reference, ...prototypeArgs(c.command), '--project', store], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Europe/Paris' },
  });
  writeFileSync(join(out, c.file), stdout);
}
writeFileSync(join(out, 'cases.json'), `${JSON.stringify(cases, null, 2)}\n`);

// The view data of each transcript, without `generated` (the time it was written), and with
// `session.file` relative to the store, so that no local path is written.
const views = join(out, 'view');
const tmp = mkdtempSync(join(tmpdir(), 'agents-tracer-expectations-'));
mkdirSync(views, { recursive: true });
for (const [name, ref] of Object.entries(transcripts)) {
  const html = join(tmp, `${name}.html`);
  execFileSync(process.execPath, [reference, ref, '--project', store, `--html=${html}`], { encoding: 'utf8' });
  const json = /<script id="trace-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
    readFileSync(html, 'utf8'),
  )?.[1];
  if (json === undefined) throw new Error(`the prototype's HTML for ${ref} embeds no view data`);
  const data: unknown = JSON.parse(json);
  if (typeof data !== 'object' || data === null || !('session' in data)) throw new Error(`no view data for ${ref}`);
  const { session, ...rest } = data;
  if (typeof session !== 'object' || session === null || !('file' in session) || typeof session.file !== 'string')
    throw new Error(`no session file in the view data for ${ref}`);
  const kept = Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'generated'));
  const view = { ...kept, session: { ...session, file: relative(store, session.file) } };
  writeFileSync(join(views, `${name}.json`), `${JSON.stringify(view, null, 1)}\n`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${cases.length} cases and ${Object.keys(transcripts).length} views to ${out}`);
