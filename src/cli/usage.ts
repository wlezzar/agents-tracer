import { readFileSync } from 'node:fs';

import type { AdapterRegistry } from '../model/index.js';
import { SUBCOMMAND_TOOLS } from '../util/index.js';
import { DEFAULT_PORT } from './args.js';
import { SUBCOMMAND_TOOLS_VAR } from './env.js';

// The help and version texts.

/** The help text, naming the adapters of `adapters`. */
export function usage(adapters: AdapterRegistry): string {
  const ids = adapters.adapters.map((a) => `${a.id} (${a.displayName})`).join(', ');
  return `agents-tracer: where did the time go in a coding-agent session?

Usage:
  agents-tracer list                  the project's sessions, oldest first
  agents-tracer report <session>      where a session's time went
  agents-tracer html <session>        a session's interactive timeline, in one HTML file
  agents-tracer serve                 browse every session's timeline on 127.0.0.1

A <session> is a session's id or a prefix of it, a subagent's id or a prefix of it, or the path of a
transcript.

Report options:
  --timeline              add every model call, tool call, and idle gap, in order
  --turn <n>              show only turn <n> in the timeline
  --top <n>               rows in the by-command and slowest tables (default: 10)
  --no-subagents          leave out the subagents
  --min-idle <seconds>    the shortest idle gap the timeline shows (default: 1)

Html options:
  --out <file>            where to write it (default: $XDG_CACHE_HOME, or ~/.cache, then
                          agents-tracer/html/<session id>.html)

Serve options:
  --port <n>              the port to listen on (default: ${DEFAULT_PORT})

Options:
  --adapter <id>          the agent whose transcripts to read (default: ${adapters.defaultId}); one of:
                          ${ids}
  --store <dir>           the directory of the project's sessions (default: the adapter's, for the
                          current directory); --project is an alias
  -h, --help              show this help
  --version               show the version

Environment:
  ${SUBCOMMAND_TOOLS_VAR}
                          more command-line tools whose first word after any flags is a
                          subcommand that keys their shell commands, separated by commas or spaces
                          (built in: ${SUBCOMMAND_TOOLS.join(', ')})`;
}

/** The version in package.json, two directories up from this module (src/cli/ or dist/cli/). */
export function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
    ? pkg.version
    : 'unknown';
}
