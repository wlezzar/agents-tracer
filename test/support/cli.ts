import { run, type CliIo } from '../../src/cli/run.js';
import type { AdapterRegistry } from '../../src/model/index.js';
import { DATA_PLACEHOLDER } from '../../src/view/index.js';

// Runs the CLI in process and captures what it prints.

/** What a run of the CLI printed, and its exit code. */
export interface CliRun {
  readonly code: number;
  /** Standard output, each printed text followed by a newline, as a terminal shows it. */
  readonly stdout: string;
  readonly stderr: string;
}

/** How to run the CLI: where, for whom, with which adapters, and the rest of its IO. */
export interface CliRunOptions extends Partial<Omit<CliIo, 'out' | 'err'>> {
  readonly adapters?: AdapterRegistry;
}

/**
 * Runs the CLI with `argv` in `cwd`, for a user whose home is `home`, with an empty environment and
 * the stub viewer page {@link TEST_VIEWER} unless told otherwise.
 */
export async function runCli(argv: readonly string[], options: CliRunOptions = {}): Promise<CliRun> {
  const {
    adapters,
    cwd = '/home/dev/shop',
    home = '/home/dev',
    env = {},
    viewer = () => TEST_VIEWER,
    ...rest
  } = options;
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    cwd,
    home,
    env,
    viewer,
    ...rest,
    out: (text: string) => {
      stdout += `${text}\n`;
    },
    err: (text: string) => {
      stderr += `${text}\n`;
    },
  };
  const code = adapters === undefined ? await run(argv, io) : await run(argv, io, adapters);
  return { code, stdout, stderr };
}

/** A stand-in for the built viewer: a page that holds the data placeholder and nothing else. */
export const TEST_VIEWER = `<!doctype html><title>viewer</title><script id="trace-data" type="application/json">${DATA_PLACEHOLDER}</script>`;
