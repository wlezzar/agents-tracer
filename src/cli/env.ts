import type { LoadOptions } from '../model/index.js';

// What the CLI reads from the environment, apart from XDG_CACHE_HOME (run.ts).

/**
 * The environment variable that names more command-line tools whose subcommand is part of a shell
 * command's key, beyond the built-in ones (util's `SUBCOMMAND_TOOLS`): names separated by commas or
 * spaces, such as the person's own tools.
 */
export const SUBCOMMAND_TOOLS_VAR = 'AGENTS_TRACER_SUBCOMMAND_TOOLS';

/** The shell key options `env` sets, which the adapter, the report, and the view share. */
export function shellOptions(env: Readonly<Record<string, string | undefined>>): LoadOptions {
  const names = (env[SUBCOMMAND_TOOLS_VAR] ?? '').split(/[\s,]+/).filter((name) => name !== '');
  return names.length ? { subcommandTools: names } : {};
}
