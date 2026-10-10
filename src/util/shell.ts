import { basename } from 'node:path';

// Groups shell commands by what they ran, so `cd x && for i in 1 2; do pnpm check | tail; done` is
// `pnpm check`: the first command of the script that is not plumbing.

/** Commands that only set the stage for the one that does the work. */
const plumbing: ReadonlySet<string> = new Set([
  'cd',
  'mkdir',
  'export',
  'set',
  'echo',
  'printf',
  'true',
  'done',
  'fi',
  'else',
  'for',
  'while',
  'if',
  'rm',
  'local',
  'trap',
  'source',
  '.',
  'unset',
  'shopt',
  '[',
  '[[',
  'test',
]);

/**
 * The key a shell command is grouped by: the {@link commandKey} of its first command that is not
 * plumbing. Commands are split on `&&`, `||`, `;`, newlines, `do`, and `then`, and only the first
 * command of a pipeline counts. A leading `(` or `{`, variable assignments, and `time`, `nohup`,
 * or `timeout <duration>` are skipped, and `x=$(…)` captures are plumbing. A script of plumbing
 * only is `(plumbing only)`.
 */
export function shellKey(command: string | undefined, options: ShellKeyOptions = {}): string {
  const segments = (command ?? '')
    .split(/&&|\|\||;|\n|\bdo\b|\bthen\b/)
    .map((s) => (s.split(/(?<!\|)\|(?!\|)/)[0] ?? '').trim());
  for (let s of segments) {
    // x=$(…) captures are plumbing too, and their quotes break the split.
    if (/^\w+=\S*\$\(/.test(s)) continue;
    for (;;) {
      const next = s
        .replace(/^[({]\s*/, '')
        .replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s*)+/, '')
        .replace(/^(time|nohup|timeout\s+\S+)\s+/, '');
      if (next === s) break;
      s = next;
    }
    const head = basename(s.split(/\s+/)[0] ?? '');
    if (head && !plumbing.has(head)) return commandKey(s, options);
  }
  return '(plumbing only)';
}

/**
 * Tools whose first word after any flags is the subcommand that says what they did. Only widely
 * used public tools are built in; {@link ShellKeyOptions.subcommandTools} adds others.
 */
export const SUBCOMMAND_TOOLS: readonly string[] = ['pnpm', 'npm', 'yarn', 'npx', 'git', 'mise', 'docker', 'aws', 'gh'];

const withSubcommand: ReadonlySet<string> = new Set(SUBCOMMAND_TOOLS);

/** How shell commands are keyed. */
export interface ShellKeyOptions {
  /**
   * More tools whose first word after any flags is the subcommand, beyond {@link SUBCOMMAND_TOOLS}:
   * the person's own command-line tools, which the CLI reads from `AGENTS_TRACER_SUBCOMMAND_TOOLS`.
   */
  readonly subcommandTools?: readonly string[];
}

/** Flags of those tools that take a value, which is not the subcommand. */
const valueFlags: ReadonlySet<string> = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '-c']);

/** Subcommands that run another program, which is part of the key. */
const runners: ReadonlySet<string> = new Set(['exec', 'run', 'dlx', 'x']);

/**
 * The key of one command: the program's base name, and for tools with subcommands (`git`, `pnpm`,
 * …, and `options.subcommandTools`) the subcommand too, skipping flags and the values of `--filter`, `-C`, and the like:
 * `pnpm --filter ui test` is `pnpm test`, `git -C repo log` is `git log`. A subcommand that runs
 * another program keeps that program's base name: `pnpm exec tsc` is `pnpm exec tsc`. An empty
 * command is `(empty)`.
 */
export function commandKey(command: string, options: ShellKeyOptions = {}): string {
  const t = command.split(/\s+/);
  const head = basename(t[0] ?? '');
  if (withSubcommand.has(head) || (options.subcommandTools?.includes(head) ?? false)) {
    let word = '';
    let at = t.length;
    for (let i = 1; i < t.length; i++) {
      const token = t[i] ?? '';
      if (valueFlags.has(token)) i++;
      else if (!token.startsWith('-')) {
        word = token;
        at = i;
        break;
      }
    }
    const program = t[at + 1];
    if (runners.has(word) && program) return `${head} ${word} ${basename(program)}`;
    return `${head} ${word}`.trim();
  }
  return head || '(empty)';
}
