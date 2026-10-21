import type { Session, SessionSummary } from './session.js';

/**
 * Reads one coding agent's local transcripts into the neutral model. Only an adapter knows its
 * agent's transcript format, file layout, and tool names; everything else reads what it returns.
 *
 * A store is the directory that holds one project's sessions. Synchronous file IO is fine: the CLI
 * and the server read one store at a time.
 */
export interface Adapter {
  /** The id `--adapter` takes, such as `claude-code`. */
  readonly id: string;
  /** The agent's name as people know it, such as `Claude Code`. */
  readonly displayName: string;
  /** The store that holds the sessions of the project in `cwd`, for the user whose home is `home`. */
  defaultStore(cwd: string, home: string): string;
  /**
   * The store's sessions, oldest first by start, ties in the adapter's discovery order. Sessions
   * without any timestamped record are left out. Throws when the store cannot be read.
   */
  listSessions(store: string): SessionSummary[];
  /**
   * The transcript file that `ref` names: an existing file path (unless `options.paths` is false),
   * a session id or a unique prefix of one, or a subagent's id or a unique prefix of one. Throws an
   * `Error` whose message says what went wrong (no match, or how many matched) when `ref` names no
   * single transcript. The server passes the id of a URL `/s/<id>`, which is only ever ASCII
   * letters, digits, `_`, and `-`.
   */
  resolve(store: string, ref: string, options?: ResolveOptions): string;
  /** Reads a transcript file, with its subagents and groups when it is a session's main transcript. */
  load(path: string, options?: LoadOptions): Session;
  /**
   * A stamp of what `load(path)` would read, which changes whenever any of it changes: for an
   * adapter that reads files, say, their count, sizes, and newest modification time, the subagents'
   * included. The server keeps a session's page until its version changes; an adapter without
   * `version` has the page built on every request.
   */
  version?(path: string): string;
}

/** How {@link Adapter.load} reads a session. */
export interface LoadOptions {
  /**
   * More command-line tools whose first word after any flags is a subcommand, for an adapter whose
   * tool previews show a shell command's key (util's `shellKey`, given the same list): the person's
   * own tools, beyond util's built-in `SUBCOMMAND_TOOLS`.
   */
  readonly subcommandTools?: readonly string[];
  /**
   * Whether to read each transcript's conversation (`Transcript.conversation`) too: everything it
   * says, which the timing does not need. False by default.
   */
  readonly conversation?: boolean;
}

/** How {@link Adapter.resolve} reads a reference. */
export interface ResolveOptions {
  /**
   * Whether a reference may be a file's path; true by default. The server passes false, so that a
   * reference taken from a URL only ever names a session or an agent by id.
   */
  readonly paths?: boolean;
}

/** The adapters the CLI and the server can use, found by id. */
export interface AdapterRegistry {
  /** Every adapter, in the order help text lists them. */
  readonly adapters: readonly Adapter[];
  /** The id of the adapter used when none is asked for. */
  readonly defaultId: string;
  /** The adapter with this id, if there is one. */
  find(id: string): Adapter | undefined;
  /** The adapter with this id; throws an `Error` naming the known ids when there is none. */
  get(id: string): Adapter;
}
