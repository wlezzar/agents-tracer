import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeCode } from '../adapters/claude-code/index.js';
import { CONVERSATION, CONVERSATION_STORE } from '../../test/support/fixtures.js';
import { session, toolCall, transcript } from '../../test/support/memory-adapter.js';
import { estimateTokens, previewBeside, sessionConversation } from './build.js';
import type { ModelItem, Thread, ToolBlock } from './types.js';

const file = join(CONVERSATION_STORE, `${CONVERSATION.session}.jsonl`);
const fixture = () => sessionConversation(claudeCode.load(file, { conversation: true }));
const models = (t: Thread): ModelItem[] => t.turns.flatMap((turn) => turn.items).filter((i) => i.type === 'model');
const tools = (t: Thread): ToolBlock[] =>
  models(t)
    .flatMap((m) => m.blocks)
    .filter((b) => b.type === 'tool');

describe('a session’s conversation', () => {
  it('has the main thread, then each agent’s, with where it was launched', () => {
    const c = fixture();
    expect(c.session).toEqual({
      id: CONVERSATION.session,
      title: 'Checkout button state',
      cwd: '/home/dev/shop',
      file,
    });
    expect(c.shellLabel).toBe('Bash');
    expect(c.threads.map((t) => [t.id, t.label, t.parent, t.launcher, t.agentType])).toEqual([
      ['main', 'Main session', null, null, null],
      [CONVERSATION.agent, "Check the form's accessibility", 'main', 'toolu_c04', 'reviewer'],
    ]);
  });

  it('cuts each thread into the analysis’s turns, with what came before the first prompt as turn 0', () => {
    const [main] = fixture().threads;
    expect(main?.turns.map((t) => [t.n, t.kind, t.items.length])).toEqual([
      [0, null, 1],
      [1, 'you', 13],
      [2, 'command', 4],
      [3, 'task', 3],
      [4, 'you', 2],
    ]);
    expect(main?.turns[1]?.active).toBeGreaterThan(0);
  });

  it('merges a model call’s records and puts each tool call’s result beside it', () => {
    const [main] = fixture().threads;
    if (main === undefined) throw new Error('no main thread');
    const [first] = models(main);
    expect(first?.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool']);
    expect(first).toMatchObject({
      id: 'msg_c01',
      model: 'claude-opus-4-1',
      context: 17003,
      out: 120,
      stop: 'tool_use',
    });
    expect(tools(main).map((b) => [b.name, b.status, b.permission, b.agent])).toEqual([
      ['Read', 'ok', { allowed: true, by: 'mode' }, null],
      ['Bash', 'error', { allowed: true, by: 'you' }, null],
      ['Bash', 'error', { allowed: false, by: 'permission-rule' }, null],
      ['Agent', 'ok', null, CONVERSATION.agent],
    ]);
    const [read] = tools(main);
    expect(read?.output).toContain('Place order');
    expect(read).toMatchObject({ ms: 500, tokens: estimateTokens(read?.output ?? '') });
  });

  it('reads no context for a call the agent wrote itself', () => {
    const [main] = fixture().threads;
    if (main === undefined) throw new Error('no main thread');
    expect(models(main).find((m) => m.synthetic)).toMatchObject({ error: true, context: null, out: null });
  });

  it('counts what a person improving the harness looks for', () => {
    const [main] = fixture().threads;
    expect(main?.stats).toMatchObject({
      calls: 9,
      toolCalls: 4,
      failed: 2,
      denied: 1,
      peakContext: 19803,
      contextItems: 7,
      compactions: 1,
    });
  });

  it('reads what the events say for an adapter that reads no conversation', () => {
    const t0 = Date.UTC(2026, 0, 5, 9, 0);
    const c = sessionConversation(
      session(
        transcript('m1', [
          { kind: 'prompt', ts: t0, text: 'Run the tests' },
          {
            kind: 'response',
            ts: t0 + 1000,
            messageId: 'r1',
            synthetic: false,
            stop: 'tool_use',
            blocks: ['thinking', 'text', 'tool_use'],
            text: 'Running them.',
            toolCalls: [toolCall('c1', 'Shell', 'shell', { preview: 'make test', inputText: 'make test' })],
          },
          {
            kind: 'tool_result',
            ts: t0 + 4000,
            toolCallId: 'c1',
            isError: false,
            interrupted: false,
            output: 'ok',
            async: false,
            backgroundIds: [],
            launches: {},
          },
          { kind: 'interrupt', ts: t0 + 5000 },
        ]),
        { shellToolName: 'Shell' },
      ),
    );
    const [main] = c.threads;
    expect(c.shellLabel).toBe('Shell');
    expect(main?.turns).toHaveLength(1);
    expect(main?.turns[0]?.items.map((i) => i.type)).toEqual(['prompt', 'model', 'notice']);
    const model = main === undefined ? undefined : models(main)[0];
    expect(model?.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool']);
    expect(model?.blocks[2]).toMatchObject({ name: 'Shell', category: 'shell', output: 'ok', status: 'ok', ms: 3000 });
  });
});

describe('previewBeside', () => {
  it('drops the purpose a preview starts with, whole or cut short', () => {
    expect(previewBeside('Run the tests · pnpm test', 'Run the tests')).toBe('pnpm test');
    expect(previewBeside('Run the tests of the whole w… · pnpm test', 'Run the tests of the whole workspace')).toBe(
      'pnpm test',
    );
    expect(previewBeside('src/cart.ts', '')).toBe('src/cart.ts');
    expect(previewBeside('Review it', 'Review it')).toBe('');
    expect(previewBeside('Other · pnpm test', 'Run the tests')).toBe('Other · pnpm test');
  });
});
