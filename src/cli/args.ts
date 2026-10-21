import { parseArgs } from 'node:util';

import { MAX_OUTPUT } from '../conversation/index.js';

// The command line, parsed into one command with its options checked: which command, which of the
// options it takes, and values of the right kind. Every mistake is a UsageError, whose message is
// one line.

/** A mistake on the command line. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

const OPTIONS = {
  adapter: { type: 'string' },
  store: { type: 'string' },
  project: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  timeline: { type: 'boolean' },
  turn: { type: 'string' },
  top: { type: 'string' },
  'no-subagents': { type: 'boolean' },
  'min-idle': { type: 'string' },
  out: { type: 'string' },
  port: { type: 'string' },
  conversation: { type: 'boolean' },
  context: { type: 'boolean' },
  'max-output': { type: 'string' },
} as const;

type OptionName = keyof typeof OPTIONS;

const GLOBAL: readonly OptionName[] = ['adapter', 'store', 'project', 'help', 'version'];

const COMMANDS = {
  list: [],
  report: ['timeline', 'turn', 'top', 'no-subagents', 'min-idle'],
  html: ['out', 'conversation'],
  transcript: ['out', 'context', 'max-output', 'no-subagents', 'turn'],
  serve: ['port'],
} as const satisfies Record<string, readonly OptionName[]>;

export type CommandName = keyof typeof COMMANDS;

/** The options every command takes: which adapter reads the transcripts, and from which store. */
export interface GlobalOptions {
  /** The adapter's id; the registry's default when absent. */
  readonly adapter?: string;
  /** The store, from `--store` or its alias `--project`; the adapter's default store when absent. */
  readonly store?: string;
}

/** What the command line asks for. */
export type Command =
  | { readonly name: 'help' }
  | { readonly name: 'version' }
  | { readonly name: 'list'; readonly global: GlobalOptions }
  | {
      readonly name: 'report';
      readonly global: GlobalOptions;
      /** The session: an id, a prefix of one, or a transcript's path. */
      readonly session: string;
      readonly timeline: boolean;
      readonly turn?: number;
      readonly top: number;
      readonly subagents: boolean;
      /** Seconds. */
      readonly minIdle: number;
    }
  | {
      readonly name: 'html';
      readonly global: GlobalOptions;
      readonly session: string;
      readonly out?: string;
      /** Write the conversation page rather than the timeline. */
      readonly conversation: boolean;
    }
  | {
      readonly name: 'transcript';
      readonly global: GlobalOptions;
      readonly session: string;
      readonly out?: string;
      /** Write the harness's context items in full. */
      readonly context: boolean;
      /** The most characters of each input, output, and context item; 0 keeps all. */
      readonly maxOutput: number;
      readonly subagents: boolean;
      readonly turn?: number;
    }
  | { readonly name: 'serve'; readonly global: GlobalOptions; readonly port: number };

/** The port `serve` listens on by default. */
export const DEFAULT_PORT = 4390;

function isOption(name: string): name is OptionName {
  return Object.hasOwn(OPTIONS, name);
}

function isCommand(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

function takes(command: CommandName, option: OptionName): boolean {
  const own: readonly OptionName[] = COMMANDS[command];
  return GLOBAL.includes(option) || own.includes(option);
}

/** The value given to an option on the command line, and how it was spelled, for messages. */
interface Given {
  readonly raw: string;
  readonly value: string | undefined;
  /**
   * The next argument, which parseArgs took as the value though it starts with `-`: most likely an
   * option, such as `--timeline` in `--store --timeline`, so the option is taken to have no value.
   */
  readonly swallowed?: string;
}

function wholeNumber(raw: string, value: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) {
    const range = max === Number.MAX_SAFE_INTEGER ? `${min} or more` : `from ${min} to ${max}`;
    throw new UsageError(`${raw} takes a whole number ${range}, not "${value}"`);
  }
  return n;
}

function seconds(raw: string, value: string): number {
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) throw new UsageError(`${raw} takes a number of seconds, not "${value}"`);
  return Number(value);
}

function sessionOf(command: CommandName, rest: readonly string[]): string {
  const [session, ...extra] = rest;
  if (session === undefined)
    throw new UsageError(`${command} needs a session: its id, a prefix of its id, or a transcript's path`);
  if (extra.length) throw new UsageError(`${command} takes one session, not ${rest.length}: ${rest.join(' ')}`);
  return session;
}

function noArguments(command: CommandName, rest: readonly string[]): void {
  if (rest.length) throw new UsageError(`${command} takes no arguments, not ${rest.join(' ')}`);
}

/** The command `argv` (the arguments after the program's name) asks for; throws a UsageError for a mistake. */
export function parseCommand(argv: readonly string[]): Command {
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const positionals: string[] = [];
  const given = new Map<OptionName, Given>();
  const unknown: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'positional') positionals.push(token.value);
    else if (token.kind === 'option') {
      if (!isOption(token.name)) unknown.push(token.rawName);
      else if (OPTIONS[token.name].type === 'string' && token.inlineValue === false && token.value.startsWith('-'))
        given.set(token.name, { raw: token.rawName, value: undefined, swallowed: token.value });
      else given.set(token.name, { raw: token.rawName, value: token.value });
    }
  }
  const swallowed = [...given.values()].flatMap((g) => g.swallowed ?? []);
  if (given.has('help') || swallowed.some((s) => s === '--help' || s === '-h')) return { name: 'help' };
  if (given.has('version') || swallowed.includes('--version')) return { name: 'version' };

  const [name, ...rest] = positionals;
  if (name === undefined) {
    if (unknown[0] !== undefined) throw new UsageError(`unknown option ${unknown[0]}`);
    return { name: 'help' };
  }
  if (!isCommand(name)) throw new UsageError(`unknown command "${name}"`);
  if (unknown[0] !== undefined) throw new UsageError(`unknown option ${unknown[0]}`);
  for (const [option, { raw, value, swallowed: next }] of given) {
    if (!takes(name, option)) throw new UsageError(`${raw} does not apply to ${name}`);
    const type: string = OPTIONS[option].type;
    if (type === 'boolean' && value !== undefined) throw new UsageError(`${raw} takes no value`);
    if (type === 'string' && value === undefined)
      throw new UsageError(
        next === undefined
          ? `${raw} needs a value`
          : `${raw} needs a value; write ${raw}=<value> for one that starts with -`,
      );
  }
  const flag = (option: OptionName): boolean => given.has(option);
  const text = (option: OptionName): string | undefined => given.get(option)?.value;
  const parsed = <T>(option: OptionName, parse: (raw: string, value: string) => T): T | undefined => {
    const g = given.get(option);
    return g?.value === undefined ? undefined : parse(g.raw, g.value);
  };

  if (flag('store') && flag('project')) throw new UsageError('give --store or --project, not both');
  const adapter = text('adapter');
  const store = text('store') ?? text('project');
  const global: GlobalOptions = { ...(adapter !== undefined && { adapter }), ...(store !== undefined && { store }) };

  switch (name) {
    case 'list':
      noArguments(name, rest);
      return { name, global };
    case 'report': {
      const session = sessionOf(name, rest);
      const turn = parsed('turn', (raw, v) => wholeNumber(raw, v, 1));
      return {
        name,
        global,
        session,
        timeline: flag('timeline'),
        ...(turn !== undefined && { turn }),
        top: parsed('top', (raw, v) => wholeNumber(raw, v, 0)) ?? 10,
        subagents: !flag('no-subagents'),
        minIdle: parsed('min-idle', seconds) ?? 1,
      };
    }
    case 'html': {
      const session = sessionOf(name, rest);
      const out = text('out');
      return { name, global, session, ...(out !== undefined && { out }), conversation: flag('conversation') };
    }
    case 'transcript': {
      const session = sessionOf(name, rest);
      const out = text('out');
      const turn = parsed('turn', (raw, v) => wholeNumber(raw, v, 1));
      return {
        name,
        global,
        session,
        ...(out !== undefined && { out }),
        context: flag('context'),
        maxOutput: parsed('max-output', (raw, v) => wholeNumber(raw, v, 0)) ?? MAX_OUTPUT,
        subagents: !flag('no-subagents'),
        ...(turn !== undefined && { turn }),
      };
    }
    case 'serve':
      noArguments(name, rest);
      return { name, global, port: parsed('port', (raw, v) => wholeNumber(raw, v, 0, 65535)) ?? DEFAULT_PORT };
  }
}
