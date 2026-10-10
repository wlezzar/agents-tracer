import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createRegistry, registry } from '../src/adapters/registry.js';
import { claudeCode } from '../src/adapters/claude-code/index.js';
import type { ToolResultEvent } from '../src/model/index.js';
import { shellOptions } from '../src/cli/env.js';
import { defaultHtmlPath } from '../src/cli/run.js';
import { isRecord } from '../src/util/index.js';
import { runCli } from './support/cli.js';
import { CLAUDE_CODE_STORE as store, FIXTURES, SESSIONS } from './support/fixtures.js';
import { createMemoryAdapter, session, toolCall, transcript } from './support/memory-adapter.js';

// The CLI end to end, in process: what it prints, where, and its exit code.

const expected = (file: string) => readFileSync(join(FIXTURES, 'claude-code', 'expected', file), 'utf8');

describe('help and version', () => {
  it('prints the help, naming the commands and the adapters', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['report', '--help']]) {
      const { code, stdout, stderr } = await runCli(argv);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toMatch(/^agents-tracer: where did the time go/);
      for (const command of ['list', 'report <session>', 'html <session>', 'serve'])
        expect(stdout).toContain(`agents-tracer ${command}`);
      expect(stdout).toContain('claude-code (Claude Code)');
    }
  });

  it('prints the package’s version', async () => {
    const pkg: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    const version = isRecord(pkg) ? pkg['version'] : undefined;
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(await runCli(['--version'])).toEqual({ code: 0, stdout: `${String(version)}\n`, stderr: '' });
  });
});

describe('the store', () => {
  const home = mkdtempSync(join(tmpdir(), 'agents-tracer-home-'));
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('is the adapter’s store for the working directory by default', async () => {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    symlinkSync(store, join(home, '.claude', 'projects', '-home-dev-shop'));
    expect(await runCli(['list'], { cwd: '/home/dev/shop', home })).toEqual({
      code: 0,
      stdout: expected('list.txt'),
      stderr: '',
    });
  });

  it('is --store, or --project', async () => {
    expect((await runCli(['list', '--store', store])).stdout).toBe(expected('list.txt'));
    expect((await runCli(['list', '--project', store])).stdout).toBe(expected('list.txt'));
  });

  it('says so when it does not exist', async () => {
    const missing = join(home, 'nowhere');
    const message = `agents-tracer: no store at ${missing}; name the directory of the project's sessions with --store <dir>\n`;
    expect(await runCli(['list', '--store', missing])).toEqual({ code: 1, stdout: '', stderr: message });
    expect(await runCli(['report', '5e1f', '--store', missing])).toEqual({ code: 1, stdout: '', stderr: message });
  });
});

describe('relative paths', () => {
  // vitest runs in the repository, so the store is not the process's working directory.
  it('reads a transcript’s path and --store relative to the working directory', async () => {
    expect(process.cwd()).not.toBe(store);
    expect(await runCli(['report', `${SESSIONS.badge}.jsonl`, '--store', '/nowhere'], { cwd: store })).toEqual({
      code: 0,
      stdout: expected('badge.txt'),
      stderr: '',
    });
    expect(await runCli(['list', '--store', '.'], { cwd: store })).toEqual({
      code: 0,
      stdout: expected('list.txt'),
      stderr: '',
    });
    expect((await runCli(['list', '--store', 'store'], { cwd: join(store, '..') })).stdout).toBe(expected('list.txt'));
  });

  it('takes a relative path that names no file there as an id, never as a file of the process’s directory', async () => {
    expect(existsSync('package.json')).toBe(true);
    expect(await runCli(['report', 'package.json', '--store', store], { cwd: store })).toEqual({
      code: 1,
      stdout: '',
      stderr: `agents-tracer: no session or agent matches "package.json" in ${store}\n`,
    });
  });
});

describe('report', () => {
  it('reads a session by a transcript’s path, whatever the store', async () => {
    const file = join(store, `${SESSIONS.badge}.jsonl`);
    expect((await runCli(['report', file, '--store', '/nowhere'])).stdout).toBe(expected('badge.txt'));
  });

  it.each([
    ['5e', '"5e" matches 2 sessions; give more of the id'],
    ['a', '"a" matches 4 agents'],
    ['zz', `no session or agent matches "zz" in ${store}`],
  ])('refuses %s, which names no single transcript', async (ref, message) => {
    expect(await runCli(['report', ref, '--store', store])).toEqual({
      code: 1,
      stdout: '',
      stderr: `agents-tracer: ${message}\n`,
    });
  });
});

describe('html', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-tracer-html-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const embedded = (file: string): unknown =>
    JSON.parse(/application\/json">(.*)<\/script>/s.exec(readFileSync(file, 'utf8'))?.[1] ?? 'null');

  it('writes the session’s page to --out, relative to the working directory, and says where and how big', async () => {
    const result = await runCli(['html', '5e1f', '--store', store, '--out', 'pages/badge.html'], { cwd: dir });
    const file = join(dir, 'pages', 'badge.html');
    const size = Math.round(readFileSync(file).length / 1024);
    expect(result).toEqual({ code: 0, stdout: `Wrote pages/badge.html (${size}K)\n`, stderr: '' });
    expect(readFileSync(file, 'utf8')).toMatch(/^<!doctype html><title>viewer<\/title>/);
    expect(embedded(file)).toMatchObject({ session: { id: SESSIONS.badge }, shellLabel: 'Bash' });
  });

  it('writes under $XDG_CACHE_HOME by default, else under ~/.cache, named after the transcript', async () => {
    const env = { XDG_CACHE_HOME: join(dir, 'cache') };
    const file = join(dir, 'cache', 'agents-tracer', 'html', `${SESSIONS.compaction}.html`);
    const cached = await runCli(['html', 'c3d4', '--store', store], { env });
    expect(cached.code).toBe(0);
    expect(cached.stdout).toContain(`Wrote ${file} (`);
    expect(existsSync(file)).toBe(true);
    const agent = join(dir, '.cache', 'agents-tracer', 'html', 'agent-a1b2c3d4e5f6a7b8c.html');
    const home = await runCli(['html', 'a1b2', '--store', store], { home: dir });
    expect(home.code).toBe(0);
    expect(home.stdout).toContain(`Wrote ${agent} (`);
    expect(embedded(agent)).toMatchObject({ session: { id: 'agent-a1b2c3d4e5f6a7b8c' }, groups: [{ id: 'main' }] });
  });

  it('takes $XDG_CACHE_HOME only when it is an absolute path', () => {
    expect(defaultHtmlPath({ home: '/home/dev', env: { XDG_CACHE_HOME: '/var/cache/dev' } }, 'x')).toBe(
      '/var/cache/dev/agents-tracer/html/x.html',
    );
    expect(defaultHtmlPath({ home: '/home/dev', env: { XDG_CACHE_HOME: 'cache' } }, 'x')).toBe(
      '/home/dev/.cache/agents-tracer/html/x.html',
    );
    expect(defaultHtmlPath({ home: '/home/dev', env: {} }, 'x')).toBe('/home/dev/.cache/agents-tracer/html/x.html');
  });

  it('says so when the viewer is not built', async () => {
    const result = await runCli(['html', '5e1f', '--store', store, '--out', join(dir, 'x.html')], {
      viewer: () => {
        throw new Error('the viewer is not built: no dist/viewer/viewer.html; run pnpm build');
      },
    });
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'agents-tracer: the viewer is not built: no dist/viewer/viewer.html; run pnpm build\n',
    });
  });
});

describe('serve', () => {
  it('serves the store on 127.0.0.1 until its signal aborts', async () => {
    const controller = new AbortController();
    const result = await runCli(['serve', '--store', store, '--port', '0'], { signal: controller.signal });
    expect(result.code).toBe(0);
    const url = /^Serving (.*) on (http:\/\/127\.0\.0\.1:\d+\/)\n$/.exec(result.stdout);
    expect(url?.[1]).toBe(store);
    const base = url?.[2] ?? '';
    const res = await fetch(`${base}s/5e1f`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SESSIONS.badge);
    controller.abort();
    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) {
      closed = await fetch(base).then(
        () => false,
        () => true,
      );
      if (!closed) await new Promise((done) => setTimeout(done, 25));
    }
    expect(closed).toBe(true);
  });

  it('refuses a store that does not exist, and a port that is taken', async () => {
    const missing = join(tmpdir(), 'agents-tracer-no-such-store');
    expect(await runCli(['serve', '--store', missing])).toEqual({
      code: 1,
      stdout: '',
      stderr: `agents-tracer: no store at ${missing}; name the directory of the project's sessions with --store <dir>\n`,
    });
    const taken = createServer();
    await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
    const address = taken.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const result = await runCli(['serve', '--store', store, '--port', String(port)]);
    taken.close();
    expect([result.code, result.stdout]).toEqual([1, '']);
    expect(result.stderr).toMatch(/^agents-tracer: listen EADDRINUSE.*\n$/);
  });
});

describe('errors', () => {
  it.each([
    [['bogus'], 'unknown command "bogus"'],
    [['report', '5e1f', '--bogus'], 'unknown option --bogus'],
    [['list', '--top', '3'], '--top does not apply to list'],
    [['report', '5e1f', '--top', 'x'], '--top takes a whole number 0 or more, not "x"'],
    [['list', '--adapter', 'nope'], `unknown adapter "nope"; known: ${registry.adapters.map((a) => a.id).join(', ')}`],
  ])('%j prints one line to standard error and exits 1', async (argv, message) => {
    expect(await runCli([...argv, '--store', store])).toEqual({
      code: 1,
      stdout: '',
      stderr: `agents-tracer: ${message}\n`,
    });
  });
});

describe('another adapter', () => {
  const t0 = Date.UTC(2026, 2, 20, 9, 0);
  const done: ToolResultEvent = {
    kind: 'tool_result',
    ts: t0 + 30_000,
    toolCallId: 'c1',
    isError: false,
    interrupted: false,
    output: 'ok',
    async: false,
    backgroundIds: [],
    launches: {},
  };
  const memory = createMemoryAdapter([
    session(
      transcript(
        'mem-1',
        [
          { kind: 'prompt', ts: t0, text: 'Run the tests' },
          {
            kind: 'response',
            ts: t0 + 5000,
            messageId: 'm1',
            synthetic: false,
            stop: 'tool_use',
            blocks: ['tool_use'],
            text: '',
            toolCalls: [toolCall('c1', 'sh', 'shell', { preview: 'make test', shellCommand: 'make test' })],
          },
          done,
          {
            kind: 'response',
            ts: t0 + 40_000,
            messageId: 'm2',
            synthetic: false,
            stop: 'end_turn',
            blocks: ['text'],
            text: 'All green.',
            toolCalls: [],
          },
        ],
        { title: 'Tests' },
      ),
      { shellToolName: 'sh' },
    ),
  ]);
  const adapters = createRegistry([claudeCode, memory], 'claude-code');

  it('lists and reports its sessions when --adapter names it', async () => {
    expect(await runCli(['list', '--adapter', 'memory'], { adapters })).toEqual({
      code: 0,
      stdout:
        'session  start             wall  size  title / first prompt\nmem-1    2026-03-20 10:00   40s    0K  Tests\n',
      stderr: '',
    });
    const { code, stdout } = await runCli(['report', 'mem', '--adapter', 'memory', '--timeline'], { adapters });
    expect(code).toBe(0);
    expect(stdout.split('\n')).toEqual(
      expect.arrayContaining([
        'mem-1  “Tests”',
        'sh by command (sum of call durations)',
        '  make   25s      1  25s',
        '10:00:30     25s  sh         make test',
      ]),
    );
  });

  it('keys shell commands by the subcommand of the tools AGENTS_TRACER_SUBCOMMAND_TOOLS names', async () => {
    const env = { AGENTS_TRACER_SUBCOMMAND_TOOLS: 'kubectl, make terraform' };
    const { stdout } = await runCli(['report', 'mem', '--adapter', 'memory'], { adapters, env });
    expect(stdout.split('\n')).toContain('  make test   25s      1  25s');
    const dir = mkdtempSync(join(tmpdir(), 'agents-tracer-keys-'));
    try {
      const file = join(dir, 'mem.html');
      expect((await runCli(['html', 'mem', '--adapter', 'memory', '--out', file], { adapters, env })).code).toBe(0);
      const data: unknown = JSON.parse(
        /application\/json">(.*)<\/script>/s.exec(readFileSync(file, 'utf8'))?.[1] ?? '',
      );
      expect(data).toMatchObject({ lanes: [{ bash: [['make test', 25_000, 1, 25_000, 0]] }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('terminal output', () => {
  it('shows the control characters of a transcript’s text as stand-ins, so none reaches the terminal', async () => {
    const t0 = Date.UTC(2026, 2, 21, 9, 0);
    const memory = createMemoryAdapter([
      session(
        transcript(
          'esc-1',
          [
            { kind: 'prompt', ts: t0, text: '\u001b[31mRED\u001b[0m please' },
            {
              kind: 'response',
              ts: t0 + 5000,
              messageId: 'm1',
              synthetic: false,
              stop: 'end_turn',
              blocks: ['text'],
              text: 'done \u001b[2J',
              toolCalls: [],
            },
          ],
          { title: '\u001b]0;pwned-title\u0007 \u001b[2J' },
        ),
      ),
    ]);
    const adapters = createRegistry([claudeCode, memory], 'claude-code');
    for (const argv of [
      ['list', '--adapter', 'memory'],
      ['report', 'esc', '--adapter', 'memory', '--timeline'],
    ]) {
      const { code, stdout } = await runCli(argv, { adapters });
      expect(code).toBe(0);
      expect(stdout.replace(/[\n\t]/g, '')).not.toMatch(/\p{Cc}/u);
      expect(stdout).toContain('\u241b]0;pwned-title\u2407 \u241b[2J');
    }
    const { stdout } = await runCli(['report', 'esc', '--adapter', 'memory', '--timeline'], { adapters });
    expect(stdout).toContain('you: \u241b[31mRED\u241b[0m please');
  });
});

describe('shellOptions', () => {
  it('reads the tools AGENTS_TRACER_SUBCOMMAND_TOOLS names, separated by commas or spaces', () => {
    expect(shellOptions({ AGENTS_TRACER_SUBCOMMAND_TOOLS: ' kubectl,terraform  make,,' })).toEqual({
      subcommandTools: ['kubectl', 'terraform', 'make'],
    });
    expect(shellOptions({ AGENTS_TRACER_SUBCOMMAND_TOOLS: ' , ' })).toEqual({});
    expect(shellOptions({})).toEqual({});
  });
});
