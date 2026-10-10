import { describe, expect, it } from 'vitest';

import { classify, textOf } from './classify.js';

// Claude Code records, cut down to the fields the mapping reads, and the events they become.

const ts = '2026-03-14T22:52:10.000Z';
const t0 = Date.parse(ts);
const human = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  timestamp: ts,
  origin: { kind: 'human' },
  ...extra,
});
const assistant = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: 'u-1',
  message: { model: 'claude-opus-4-1', id: 'msg_1', role: 'assistant', ...message },
  timestamp: ts,
  ...extra,
});
const result = (block: Record<string, unknown>, toolUseResult?: unknown) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...block }] },
  timestamp: ts,
  ...(toolUseResult !== undefined && { toolUseResult }),
});
const eventsOf = (...records: unknown[]) => classify(records).events;

describe('textOf', () => {
  it('reads a string, or joins the text blocks of an array with a space', () => {
    expect(textOf('hello')).toBe('hello');
    expect(textOf([{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe(' a b');
    expect(textOf(undefined)).toBe('');
    expect(textOf({ type: 'text' })).toBe('');
  });
});

describe('classify: model responses', () => {
  it('maps an assistant record to a response, with its usage, blocks, text, and tool calls', () => {
    const [event] = eventsOf(
      assistant({
        content: [
          { type: 'thinking', thinking: 'Look first.' },
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/home/dev/shop/src/a.ts' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 11 },
      }),
      { type: 'user', cwd: '/home/dev/shop' },
    );
    expect(event).toEqual({
      kind: 'response',
      ts: t0,
      messageId: 'msg_1',
      model: 'claude-opus-4-1',
      synthetic: false,
      stop: 'tool_use',
      usage: { output: 11, cacheRead: 7, cacheWrite: 5, input: 3 },
      blocks: ['thinking', 'text', 'tool_use'],
      text: 'Reading.',
      toolCalls: [
        {
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: '/home/dev/shop/src/a.ts' },
          desc: {
            category: 'file',
            preview: 'src/a.ts',
            inputText: '{\n  "file_path": "/home/dev/shop/src/a.ts"\n}',
          },
        },
      ],
    });
  });

  it('marks a synthetic response, falls back to the record id, and leaves a missing stop reason null', () => {
    const [event] = eventsOf(
      assistant({ id: undefined, model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }], usage: {} }),
    );
    expect(event).toMatchObject({
      kind: 'response',
      messageId: 'u-1',
      synthetic: true,
      stop: null,
      usage: { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 },
    });
  });

  it('has no usage when the record has none', () => {
    const [event] = eventsOf(assistant({ content: [], usage: null }));
    expect(event).not.toHaveProperty('usage');
  });
});

describe('classify: tool results', () => {
  it('makes one result per tool_result block, with its text', () => {
    const events = eventsOf({
      type: 'user',
      timestamp: ts,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'one' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'two' }, { type: 'image' }] },
        ],
      },
      toolUseResult: { backgroundTaskId: 'bk1' },
    });
    expect(events).toEqual([
      {
        kind: 'tool_result',
        ts: t0,
        toolCallId: 'toolu_1',
        isError: false,
        interrupted: false,
        output: 'one',
        async: true,
        backgroundIds: ['bk1'],
        launches: {},
      },
      {
        kind: 'tool_result',
        ts: t0,
        toolCallId: 'toolu_2',
        isError: false,
        interrupted: false,
        output: 'two\n[image]',
        async: true,
        backgroundIds: ['bk1'],
        launches: {},
      },
    ]);
  });

  it('reads errors and interruptions', () => {
    expect(eventsOf(result({ is_error: true, content: 'Exit code 1' }, 'Error: Exit code 1'))[0]).toMatchObject({
      isError: true,
      interrupted: false,
      output: 'Exit code 1',
      async: false,
    });
    expect(eventsOf(result({ is_error: true }, { interrupted: true }))[0]).toMatchObject({
      isError: true,
      interrupted: true,
      output: '',
    });
  });

  it('reads a background launch and what it started', () => {
    expect(
      eventsOf(result({ content: 'launched' }, { isAsync: true, status: 'async_launched', agentId: 'a1' }))[0],
    ).toMatchObject({ async: true, backgroundIds: ['a1'], launches: { agentId: 'a1' } });
    expect(
      eventsOf(result({ content: 'launched' }, { status: 'async_launched', runId: 'wf_1', taskId: 't1' }))[0],
    ).toMatchObject({ async: true, backgroundIds: ['t1'], launches: { groupId: 'wf_1' } });
    expect(eventsOf(result({ content: 'done' }, { status: 'completed', agentId: 'a2' }))[0]).toMatchObject({
      async: false,
      launches: { agentId: 'a2' },
    });
  });
});

describe('classify: the person, tasks, and commands', () => {
  it('maps a human prompt, joining an array content', () => {
    expect(eventsOf(human('Add a badge'))).toEqual([{ kind: 'prompt', ts: t0, text: 'Add a badge' }]);
    expect(eventsOf(human([{ type: 'text', text: 'Look' }, { type: 'image' }]))).toEqual([
      { kind: 'prompt', ts: t0, text: 'Look ' },
    ]);
  });

  it('prefixes a prompt of another origin with its kind', () => {
    expect(eventsOf(human('from the docs session', { origin: { kind: 'peer' } }))).toEqual([
      { kind: 'prompt', ts: t0, text: '[peer] from the docs session' },
    ]);
  });

  it('maps a task notification to its summary and the tool call it reports on', () => {
    const text =
      '<task-notification>\n<task-id>bk1</task-id>\n<tool-use-id>toolu_7</tool-use-id>\n<summary>Build\ndone</summary>\n</task-notification>';
    const expected = { kind: 'notification', ts: t0, text: 'Build\ndone', toolCallId: 'toolu_7' };
    expect(eventsOf(human(text, { origin: { kind: 'task-notification' } }))).toEqual([expected]);
    expect(eventsOf(human(text, { origin: undefined }))).toEqual([expected]);
    expect(eventsOf(human('a task said something', { origin: { kind: 'task-notification' } }))).toEqual([
      { kind: 'notification', ts: t0, text: 'a task said something' },
    ]);
  });

  it('maps a slash command, a compaction for /compact', () => {
    const command = (name: string) =>
      human(`<command-name>${name}</command-name>\n<command-message>x</command-message>`, { origin: undefined });
    expect(eventsOf(command('/clear'), command('/compact'))).toEqual([
      { kind: 'command', ts: t0, name: '/clear', compaction: false },
      { kind: 'command', ts: t0, name: '/compact', compaction: true },
    ]);
  });

  it('maps an interrupt and a compact summary, before looking at the origin', () => {
    expect(eventsOf(human('[Request interrupted by user for tool use]'))).toEqual([{ kind: 'interrupt', ts: t0 }]);
    expect(eventsOf(human('Summary of the session', { isCompactSummary: true, origin: undefined }))).toEqual([
      { kind: 'compaction_done', ts: t0 },
    ]);
  });

  it('skips meta records, wrappers, and, once any record has an origin, plain text without one', () => {
    const plain = human('plain text', { origin: undefined });
    expect(
      eventsOf(
        human('hidden', { isMeta: true }),
        human('<local-command-stdout>ok</local-command-stdout>', { origin: undefined }),
        plain,
        human('a prompt'),
      ),
    ).toEqual([{ kind: 'prompt', ts: t0, text: 'a prompt' }]);
    // The older format has no origin anywhere: plain text is a prompt.
    expect(eventsOf(plain)).toEqual([{ kind: 'prompt', ts: t0, text: 'plain text' }]);
  });
});

describe('classify: background signals and metadata', () => {
  const notification = '<task-notification><tool-use-id>toolu_9</tool-use-id></task-notification>';

  it('maps a queued notification, as a queue operation or an attachment, to a background-done signal', () => {
    expect(
      eventsOf(
        { type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: notification },
        { type: 'queue-operation', operation: 'remove', timestamp: ts, content: notification },
        { type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: 'a queued prompt' },
        { type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt: notification } },
      ),
    ).toEqual([
      { kind: 'background_done', ts: t0, toolCallId: 'toolu_9' },
      { kind: 'background_done', ts: t0, toolCallId: 'toolu_9' },
    ]);
  });

  it('skips records without a timestamp, but reads their title and compactions', () => {
    const classified = classify([
      { type: 'ai-title', aiTitle: 'First' },
      { type: 'user', cwd: '/home/dev/shop', message: { content: 'no time' } },
      { type: 'user', cwd: '/home/dev/other', timestamp: ts, message: { content: 'hi' } },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 100, durationMs: 5000 },
      },
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } },
      { type: 'ai-title', aiTitle: 'Last' },
    ]);
    expect(classified).toEqual({
      events: [{ kind: 'prompt', ts: t0, text: 'hi' }],
      cwd: '/home/dev/shop',
      title: 'Last',
      compactions: [{ trigger: 'manual', preTokens: 1000, postTokens: 100, durationMs: 5000 }, { trigger: 'auto' }],
    });
  });

  it('ignores records that are not objects', () => {
    expect(classify([null, 3, 'text', [human('x')]])).toEqual({ events: [], compactions: [] });
  });
});
