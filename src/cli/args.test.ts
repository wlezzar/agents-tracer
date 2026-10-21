import { describe, expect, it } from 'vitest';

import { parseCommand, UsageError } from './args.js';

describe('parseCommand', () => {
  it.each([
    [[]],
    [['-h']],
    [['--help']],
    [['report', 'abc', '--help']],
    [['bogus', '--help']],
    [['list', '--store', '-h']],
  ])('%j asks for the help', (argv) => {
    expect(parseCommand(argv)).toEqual({ name: 'help' });
  });

  it.each([[['--version']], [['list', '--version']], [['html', 'x', '--out', '--version']]])(
    '%j asks for the version',
    (argv) => {
      expect(parseCommand(argv)).toEqual({ name: 'version' });
    },
  );

  it('reads list, with the global options before or after the command', () => {
    expect(parseCommand(['list'])).toEqual({ name: 'list', global: {} });
    expect(parseCommand(['--store', '/s', 'list', '--adapter', 'claude-code'])).toEqual({
      name: 'list',
      global: { store: '/s', adapter: 'claude-code' },
    });
  });

  it('takes --project as an alias of --store', () => {
    expect(parseCommand(['list', '--project', '/s'])).toEqual({ name: 'list', global: { store: '/s' } });
  });

  it('reads report with its defaults', () => {
    expect(parseCommand(['report', '5e1f'])).toEqual({
      name: 'report',
      global: {},
      session: '5e1f',
      timeline: false,
      top: 10,
      subagents: true,
      minIdle: 1,
    });
  });

  it('reads report’s options, inline values too', () => {
    expect(
      parseCommand(['report', '5e1f', '--timeline', '--turn', '3', '--top=0', '--no-subagents', '--min-idle', '2.5']),
    ).toEqual({
      name: 'report',
      global: {},
      session: '5e1f',
      timeline: true,
      turn: 3,
      top: 0,
      subagents: false,
      minIdle: 2.5,
    });
  });

  it('takes seconds as a decimal, with or without digits before the point', () => {
    for (const [value, minIdle] of [
      ['.5', 0.5],
      ['0.5', 0.5],
      ['2.', 2],
      ['30', 30],
      ['0', 0],
    ] as const)
      expect(parseCommand(['report', 'x', '--min-idle', value])).toMatchObject({ minIdle });
  });

  it('takes a value that starts with - only inline', () => {
    expect(parseCommand(['html', 'x', '--out=-x.html'])).toMatchObject({ out: '-x.html' });
    expect(parseCommand(['list', '--store=--odd'])).toMatchObject({ global: { store: '--odd' } });
  });

  it('takes a session that looks like an option after --', () => {
    expect(parseCommand(['report', '--', '-odd'])).toMatchObject({ name: 'report', session: '-odd' });
  });

  it('reads html and serve', () => {
    expect(parseCommand(['html', '5e1f'])).toEqual({ name: 'html', global: {}, session: '5e1f', conversation: false });
    expect(parseCommand(['html', '5e1f', '--out', 'x.html', '--conversation'])).toEqual({
      name: 'html',
      global: {},
      session: '5e1f',
      out: 'x.html',
      conversation: true,
    });
    expect(parseCommand(['serve'])).toEqual({ name: 'serve', global: {}, port: 4390 });
    expect(parseCommand(['serve', '--port', '8080'])).toEqual({ name: 'serve', global: {}, port: 8080 });
  });

  it('reads transcript', () => {
    expect(parseCommand(['transcript', '5e1f'])).toEqual({
      name: 'transcript',
      global: {},
      session: '5e1f',
      context: false,
      maxOutput: 3000,
      subagents: true,
    });
    expect(
      parseCommand([
        'transcript',
        '5e1f',
        '--context',
        '--max-output',
        '0',
        '--no-subagents',
        '--turn',
        '2',
        '--out',
        'x.md',
      ]),
    ).toEqual({
      name: 'transcript',
      global: {},
      session: '5e1f',
      out: 'x.md',
      context: true,
      maxOutput: 0,
      subagents: false,
      turn: 2,
    });
  });

  it.each([
    [['transcript'], "transcript needs a session: its id, a prefix of its id, or a transcript's path"],
    [
      ['transcript', 'x', '--max-output', '-1'],
      '--max-output needs a value; write --max-output=<value> for one that starts with -',
    ],
    [['transcript', 'x', '--max-output', '2.5'], '--max-output takes a whole number 0 or more, not "2.5"'],
    [['transcript', 'x', '--timeline'], '--timeline does not apply to transcript'],
    [['report', 'x', '--conversation'], '--conversation does not apply to report'],
    [['html', 'x', '--context'], '--context does not apply to html'],
  ])('refuses %j for transcript and html: %s', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(message);
  });

  it.each([
    [['bogus'], 'unknown command "bogus"'],
    [['--bogus'], 'unknown option --bogus'],
    [['report', 'x', '--bogus'], 'unknown option --bogus'],
    [['report', 'x', '-t'], 'unknown option -t'],
    [['list', '--timeline'], '--timeline does not apply to list'],
    [['serve', '--out', 'x'], '--out does not apply to serve'],
    [['report', 'x', '--top'], '--top needs a value'],
    [['report', 'x', '--timeline=yes'], '--timeline takes no value'],
    [['report', 'x', '--top', 'ten'], '--top takes a whole number 0 or more, not "ten"'],
    [['report', 'x', '--top=-1'], '--top takes a whole number 0 or more, not "-1"'],
    [['report', 'x', '--top', '-1'], '--top needs a value; write --top=<value> for one that starts with -'],
    [['html', 'x', '--out', '--timeline'], '--out needs a value; write --out=<value> for one that starts with -'],
    [
      ['report', 'x', '--store', '--timeline'],
      '--store needs a value; write --store=<value> for one that starts with -',
    ],
    [['report', 'x', '--min-idle', '1e2'], '--min-idle takes a number of seconds, not "1e2"'],
    [['report', 'x', '--min-idle=-5'], '--min-idle takes a number of seconds, not "-5"'],
    [['report', 'x', '--min-idle', '.'], '--min-idle takes a number of seconds, not "."'],
    [['report', 'x', '--top', '2.5'], '--top takes a whole number 0 or more, not "2.5"'],
    [['report', 'x', '--turn', '0'], '--turn takes a whole number 1 or more, not "0"'],
    [['report', 'x', '--min-idle', 'soon'], '--min-idle takes a number of seconds, not "soon"'],
    [['serve', '--port', '70000'], '--port takes a whole number from 0 to 65535, not "70000"'],
    [['report'], "report needs a session: its id, a prefix of its id, or a transcript's path"],
    [['html'], "html needs a session: its id, a prefix of its id, or a transcript's path"],
    [['report', 'a', 'b'], 'report takes one session, not 2: a b'],
    [['list', 'extra'], 'list takes no arguments, not extra'],
    [['list', '--store', 'a', '--project', 'b'], 'give --store or --project, not both'],
  ])('refuses %j: %s', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(new UsageError(message));
  });
});
