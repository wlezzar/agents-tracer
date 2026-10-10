// Checks that the built CLI behaves as the prototype does, over real Claude Code transcripts: for
// every session and subagent transcript of every store, `agents-tracer report` (with and without
// --timeline, and a session with other flags) prints what the prototype prints, `agents-tracer
// list` prints what its --list prints, and the view data `agents-tracer html` embeds holds every
// field of the prototype's, with the same values.
//
//   pnpm parity [store...]      builds, then compares every store under ~/.claude/projects, or the
//                               stores given
//
// The prototype is REFERENCE_TRACE, by default local/reference/trace.mjs (gitignored: link the
// prototype's trace.mjs there). Transcripts modified in the last 15 minutes are live and skipped.
// Outputs go to a temp dir, which is kept when there is a mismatch; nothing is written to the
// repository. PARITY_JOBS sets how many comparisons run at once (a whole number from 1; by default
// the CPUs, at most 6). It exits 1 on a mismatch, and 2 when it cannot compare, or did not run
// every comparison.
//
// The CLI builds in only public tools among those whose subcommand keys a shell command; the
// prototype's list, read from its source, reaches the CLI through AGENTS_TRACER_SUBCOMMAND_TOOLS,
// so that both key commands alike. The CLI also prints control characters as visible stand-ins,
// so the prototype's output is compared after the same mapping.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const reference = resolve(process.env['REFERENCE_TRACE'] ?? join(root, 'local', 'reference', 'trace.mjs'));
const cli = join(root, 'dist', 'cli', 'main.js');
const projects = join(homedir(), '.claude', 'projects');
const LIVE_MS = 15 * 60 * 1000;
const jobsText = process.env['PARITY_JOBS'];
const jobs =
  jobsText === undefined ? Math.min(availableParallelism(), 6) : /^\d+$/.test(jobsText) ? Number(jobsText) : NaN;
/** Flags for a second report of each session, so that --turn, --top, --min-idle, and --no-subagents are compared. */
const FLAGS = ['--timeline', '--turn', '2', '--top', '3', '--min-idle', '30', '--no-subagents'];

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function node(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  return new Promise((done) => {
    execFile(process.execPath, args, { maxBuffer: 2 ** 30, encoding: 'utf8', env }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      done({ code, stdout, stderr: error !== null && code === -1 ? `${stderr}${error.message}` : stderr });
    });
  });
}

/**
 * The tools whose subcommand keys a shell command in the prototype, from the list its command key
 * checks the program against (`[...].includes(head)`); undefined when its source holds no such list.
 */
function subcommandToolsOf(source: string): string[] | undefined {
  const list = /\[((?:\s*'[^']+'\s*,?)+)\]\.includes\(head\)/.exec(source)?.[1];
  return list?.match(/'[^']+'/g)?.map((quoted) => quoted.slice(1, -1));
}

/** What the CLI prints for `text`: src/util/text.ts's printable, which shows control characters as stand-ins. */
function printable(text: string): string {
  return text.replace(/\p{Cc}/gu, (c) => {
    if (c === '\n' || c === '\t') return c;
    const code = c.charCodeAt(0);
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '\u2421' : '\ufffd';
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A store's transcripts: its sessions, and every subagent under them, each with whether it is live. */
interface Transcript {
  readonly file: string;
  readonly session: boolean;
  readonly live: boolean;
}

function newestUnder(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestUnder(join(path, name)));
  return newest;
}

function transcriptsOf(store: string, now: number): Transcript[] {
  const found: Transcript[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^agent-.*\.jsonl$/.test(name))
        found.push({ file: path, session: false, live: now - statSync(path).mtimeMs < LIVE_MS });
    }
  };
  for (const name of readdirSync(store).filter((f) => f.endsWith('.jsonl'))) {
    const file = join(store, name);
    const dir = join(store, name.slice(0, -'.jsonl'.length));
    // A session's report reads its subagents too, so it is live while any of them is.
    const newest = Math.max(statSync(file).mtimeMs, existsSync(dir) ? newestUnder(dir) : 0);
    found.push({ file, session: true, live: now - newest < LIVE_MS });
    walk(join(dir, 'subagents'));
  }
  return found;
}

/** Where two texts first differ, as a line number and both lines. */
function firstDifferingLine(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      const show = (line: string | undefined) =>
        line === undefined ? '(no line)' : JSON.stringify(line.slice(0, 200));
      return `line ${i + 1}: expected ${show(a[i])}, got ${show(b[i])}`;
    }
  }
  return 'the same lines';
}

/**
 * Where `actual` first lacks a field of `expected` or holds another value, as a path; undefined
 * when it holds all of `expected`. Fields `actual` adds are allowed.
 */
function firstDifference(expected: unknown, actual: unknown, path: string): string | undefined {
  const show = (v: unknown) => (v === undefined ? 'undefined' : JSON.stringify(v).slice(0, 200));
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${show(actual)}`;
    if (expected.length !== actual.length) return `${path}: expected ${expected.length} items, got ${actual.length}`;
    for (let i = 0; i < expected.length; i++) {
      const d = firstDifference(expected[i], actual[i], `${path}[${i}]`);
      if (d !== undefined) return d;
    }
    return undefined;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return `${path}: expected an object, got ${show(actual)}`;
    for (const [key, value] of Object.entries(expected)) {
      const d = firstDifference(value, actual[key], `${path}.${key}`);
      if (d !== undefined) return d;
    }
    return undefined;
  }
  return expected === actual ? undefined : `${path}: expected ${show(expected)}, got ${show(actual)}`;
}

/** The view data an HTML file embeds, without `generated`, the time it was written. */
function viewData(file: string): unknown {
  const html = readFileSync(file, 'utf8');
  const json = /<script id="trace-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (json === undefined) throw new Error(`${file} embeds no view data`);
  const data: unknown = JSON.parse(json);
  if (isRecord(data)) delete data['generated'];
  return data;
}

async function inPool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
  };
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker));
}

async function main(): Promise<number> {
  if (!(jobs >= 1)) {
    console.error(
      `parity: PARITY_JOBS is how many comparisons run at once, a whole number from 1, not "${jobsText ?? ''}".`,
    );
    return 2;
  }
  if (!existsSync(reference)) {
    console.error(
      `parity: no prototype at ${reference}. Set REFERENCE_TRACE to the prototype's trace.mjs, or link it at local/reference/trace.mjs.`,
    );
    return 2;
  }
  if (!existsSync(cli)) {
    console.error(`parity: no built CLI at ${cli}; run pnpm build first (pnpm parity does).`);
    return 2;
  }
  const tools = subcommandToolsOf(readFileSync(reference, 'utf8'));
  if (tools === undefined) {
    console.error(`parity: found no list of subcommand tools (\`[…].includes(head)\`) in ${reference}.`);
    return 2;
  }
  const cliEnv = { ...process.env, AGENTS_TRACER_SUBCOMMAND_TOOLS: tools.join(',') };
  const cliRun = (args: readonly string[]): Promise<Outcome> => node([cli, ...args], cliEnv);
  const args = process.argv.slice(2);
  const base = process.env['INIT_CWD'] ?? process.cwd();
  const stores = (
    args.length ? args.map((a) => resolve(base, a)) : readdirSync(projects).map((name) => join(projects, name))
  ).filter((dir) => statSync(dir).isDirectory());
  const now = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), 'agents-tracer-parity-'));

  const byStore = stores.map((store) => ({ store, transcripts: transcriptsOf(store, now) }));
  const all = byStore.flatMap((s) => s.transcripts);
  const compared = all.filter((t) => !t.live);
  const live = all.length - compared.length;

  const counts = new Map<string, number>();
  const count = (kind: string): void => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  };
  const mismatches: string[] = [];
  let files = 0;
  const keep = (label: string, expected: string, actual: string): string => {
    const n = mismatches.length + 1;
    writeFileSync(join(tmp, `mismatch-${n}-prototype.txt`), expected);
    writeFileSync(join(tmp, `mismatch-${n}-cli.txt`), actual);
    return `${label}: ${firstDifferingLine(expected, actual)} (both outputs: ${tmp}/mismatch-${n}-*.txt)`;
  };
  const compare = async (kind: string, file: string, prototypeArgs: string[], cliArgs: string[]): Promise<void> => {
    count(kind);
    const label = `${kind} ${file}`;
    const raw = await node([reference, ...prototypeArgs]);
    const expected = { ...raw, stdout: printable(raw.stdout) };
    const actual = await cliRun(cliArgs);
    if (expected.stdout !== actual.stdout) mismatches.push(keep(label, expected.stdout, actual.stdout));
    else if ((expected.code === 0) !== (actual.code === 0))
      mismatches.push(
        `${label}: exit ${expected.code} from the prototype, ${actual.code} from the CLI: ${actual.stderr}`,
      );
  };

  type Job = () => Promise<void>;
  const work: Job[] = [];
  for (const t of compared) {
    work.push(() => compare('report', t.file, [t.file], ['report', t.file]));
    work.push(() => compare('report --timeline', t.file, [t.file, '--timeline'], ['report', t.file, '--timeline']));
    if (t.session)
      work.push(() => compare(`report ${FLAGS.join(' ')}`, t.file, [t.file, ...FLAGS], ['report', t.file, ...FLAGS]));
    work.push(async () => {
      count('html');
      const n = ++files;
      const expectedFile = join(tmp, `${n}-prototype.html`);
      const actualFile = join(tmp, `${n}-cli.html`);
      const expected = await node([reference, t.file, `--html=${expectedFile}`]);
      const actual = await cliRun(['html', t.file, '--out', actualFile]);
      if ((expected.code === 0) !== (actual.code === 0))
        mismatches.push(`html ${t.file}: exit ${expected.code} from the prototype, ${actual.code} from the CLI`);
      else if (expected.code === 0) {
        try {
          const d = firstDifference(viewData(expectedFile), viewData(actualFile), 'data');
          if (d !== undefined) mismatches.push(`html ${t.file}: ${d}`);
        } catch (err) {
          mismatches.push(`html ${t.file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      rmSync(expectedFile, { force: true });
      rmSync(actualFile, { force: true });
    });
  }
  for (const { store, transcripts } of byStore) {
    work.push(async () => {
      const label = `list ${store}`;
      const listed = async (): Promise<[Outcome, Outcome]> => {
        const raw = await node([reference, '--list', '--project', store]);
        return [{ ...raw, stdout: printable(raw.stdout) }, await cliRun(['list', '--store', store])];
      };
      const live = transcripts.some((t) => t.live);
      count('list');
      let [expected, actual] = await listed();
      // A live session can change between the two runs; give it a second chance.
      if (expected.stdout !== actual.stdout && live) [expected, actual] = await listed();
      if (expected.stdout === actual.stdout) return;
      if (live) {
        count('list (live, still changing)');
        return;
      }
      mismatches.push(keep(label, expected.stdout, actual.stdout));
    });
  }

  let done = 0;
  const progress = process.stderr.isTTY;
  await inPool(work, jobs, async (job) => {
    await job();
    done++;
    if (progress) process.stderr.write(`\r${done}/${work.length}`);
  });
  if (progress) process.stderr.write('\r');

  const sessions = compared.filter((t) => t.session).length;
  console.log(`Parity with ${reference}`);
  console.log(`The prototype's ${tools.length} subcommand tools reach the CLI through AGENTS_TRACER_SUBCOMMAND_TOOLS`);
  console.log(
    `${stores.length} stores, ${compared.length} transcripts compared (${sessions} sessions, ${compared.length - sessions} subagents), ${live} live ones skipped`,
  );
  console.log(`comparisons: ${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')}`);
  // A pass needs every comparison to have run, and some to have run when there were transcripts.
  if (done !== work.length || (compared.length > 0 && (counts.get('report') ?? 0) !== compared.length)) {
    console.error(`parity: ran ${done} of ${work.length} comparisons; nothing is proved.`);
    return 2;
  }
  if (mismatches.length === 0) {
    rmSync(tmp, { recursive: true, force: true });
    console.log('0 mismatches');
    return 0;
  }
  console.log(`${mismatches.length} mismatches:`);
  for (const m of mismatches.sort()) console.log(`  ${m}`);
  return 1;
}

process.exitCode = await main();
