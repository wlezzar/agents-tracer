import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { registry as shipped } from '../adapters/registry.js';
import { analyzeSession } from '../analysis/index.js';
import type { Adapter, AdapterRegistry } from '../model/index.js';
import { report, sessionList } from '../report/index.js';
import { startServer } from '../server/index.js';
import { isRecord, printable } from '../util/index.js';
import { renderHtml, viewerTemplate, viewSession } from '../view/index.js';
import { parseCommand, type GlobalOptions } from './args.js';
import { shellOptions } from './env.js';
import { usage, version } from './usage.js';

// The CLI's commands, run against an IO of the caller's choosing so tests drive them in process.

/** What the CLI reads from and writes to. */
export interface CliIo {
  /**
   * The working directory: its project's store is the default, and relative paths (`--store`, a
   * transcript's path as the session, `--out`) are read from it.
   */
  readonly cwd: string;
  /** The user's home directory. */
  readonly home: string;
  /** The environment, for `XDG_CACHE_HOME` and `AGENTS_TRACER_SUBCOMMAND_TOOLS`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Writes `text` and a newline to standard output. */
  readonly out: (text: string) => void;
  /** Writes `text` and a newline to standard error. */
  readonly err: (text: string) => void;
  /** The built viewer's page, which `html` and `serve` fill in; the built one beside the code by default. */
  readonly viewer?: () => string;
  /** Stops `serve`'s server when it aborts; without it, the server runs until the process ends. */
  readonly signal?: AbortSignal;
}

/**
 * Where `html` writes a session's page by default: `agents-tracer/html/<id>.html` under
 * `$XDG_CACHE_HOME`, or under `~/.cache` when that is unset or not an absolute path.
 */
export function defaultHtmlPath(io: Pick<CliIo, 'env' | 'home'>, id: string): string {
  const xdg = io.env['XDG_CACHE_HOME'];
  const cache = xdg !== undefined && isAbsolute(xdg) ? xdg : join(io.home, '.cache');
  return join(cache, 'agents-tracer', 'html', `${id}.html`);
}

/**
 * A path the person gave, as the file system reads it: relative to `io.cwd`. It stays as given
 * when `io.cwd` is the process's working directory, so that what the CLI prints and the page
 * embeds shows the path as it was typed, as the prototype's do.
 */
function fsPath(io: CliIo, path: string): string {
  return isAbsolute(path) || resolve(io.cwd) === process.cwd() ? path : resolve(io.cwd, path);
}

/** The adapter and the store a command reads. */
function locate(global: GlobalOptions, io: CliIo, adapters: AdapterRegistry): { adapter: Adapter; store: string } {
  const adapter = adapters.get(global.adapter ?? adapters.defaultId);
  return {
    adapter,
    store: global.store === undefined ? adapter.defaultStore(io.cwd, io.home) : fsPath(io, global.store),
  };
}

/**
 * The transcript `ref` names in `store`, `ref` being read as a path relative to `io.cwd`: when that
 * is not the process's working directory, a relative `ref` is a file under `io.cwd` or else only an
 * id, never a file under the process's directory.
 */
function resolveSession(adapter: Adapter, store: string, ref: string, io: CliIo): string {
  const path = fsPath(io, ref);
  if (path === ref) return adapter.resolve(store, ref);
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true
    ? adapter.resolve(store, path)
    : adapter.resolve(store, ref, { paths: false });
}

/** What `read` returns; a store that does not exist is an error that says so. */
function fromStore<T>(store: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (isRecord(err) && err['code'] === 'ENOENT' && err['path'] === store)
      throw new Error(`no store at ${store}; name the directory of the project's sessions with --store <dir>`, {
        cause: err,
      });
    throw err;
  }
}

/** The first line of an error's message, which is what the CLI prints. */
function messageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

/**
 * Runs the command `argv` (the arguments after the program's name) asks for, with the adapters of
 * `adapters`, and returns the exit code: 0, or 1 after printing one line to standard error. For
 * `serve`, it returns once the server listens (or fails to); the server keeps running until
 * `io.signal` aborts or the process ends. What it prints goes through `printable`: transcripts hold
 * text from anywhere, fetched pages included, and none of it reaches the terminal as a control
 * sequence.
 */
export async function run(argv: readonly string[], io: CliIo, adapters: AdapterRegistry = shipped): Promise<number> {
  const print = (text: string): void => {
    io.out(printable(text));
  };
  try {
    const command = parseCommand(argv);
    const shell = shellOptions(io.env);
    switch (command.name) {
      case 'help':
        print(usage(adapters));
        return 0;
      case 'version':
        print(version());
        return 0;
      case 'list': {
        const { adapter, store } = locate(command.global, io, adapters);
        print(sessionList(fromStore(store, () => adapter.listSessions(store))));
        return 0;
      }
      case 'report': {
        const { adapter, store } = locate(command.global, io, adapters);
        const session = adapter.load(
          fromStore(store, () => resolveSession(adapter, store, command.session, io)),
          shell,
        );
        // Without the subagents' table, their transcripts need no analysis.
        const analysis = analyzeSession(command.subagents ? session : { ...session, agents: [] }, {
          minIdle: command.minIdle,
        });
        print(
          report(analysis, {
            top: command.top,
            timeline: command.timeline,
            subagents: command.subagents,
            ...(command.turn !== undefined && { turn: command.turn }),
            ...shell,
          }),
        );
        return 0;
      }
      case 'html': {
        const { adapter, store } = locate(command.global, io, adapters);
        const session = adapter.load(
          fromStore(store, () => resolveSession(adapter, store, command.session, io)),
          shell,
        );
        const page = renderHtml(viewSession(session, shell), (io.viewer ?? viewerTemplate)());
        const out = command.out ?? defaultHtmlPath(io, session.main.id);
        const file = resolve(io.cwd, out);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, page);
        print(`Wrote ${out} (${Math.round(statSync(file).size / 1024)}K)`);
        return 0;
      }
      case 'serve': {
        const { adapter, store } = locate(command.global, io, adapters);
        // A missing store is an error now rather than on the first request.
        fromStore(store, () => statSync(store));
        const server = await startServer({
          adapter,
          store,
          port: command.port,
          ...shell,
          ...(io.viewer !== undefined && { viewer: io.viewer }),
        });
        io.signal?.addEventListener('abort', () => void server.close(), { once: true });
        print(`Serving ${store} on ${server.url}`);
        return 0;
      }
    }
  } catch (err) {
    io.err(printable(`agents-tracer: ${messageOf(err)}`));
    return 1;
  }
}
