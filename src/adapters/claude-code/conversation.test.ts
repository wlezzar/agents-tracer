import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_STORE, CONVERSATION, CONVERSATION_STORE, sessionFile } from '../../../test/support/fixtures.js';
import type { ConversationEntry, TraceEvent } from '../../model/index.js';
import { conversationOf } from './conversation.js';
import { claudeCode } from './index.js';
import { readRecords } from './store.js';

const file = join(CONVERSATION_STORE, `${CONVERSATION.session}.jsonl`);
const entries = (): readonly ConversationEntry[] =>
  claudeCode.load(file, { conversation: true }).main.conversation ?? [];

/** Every transcript file under a directory. */
function transcripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? transcripts(path) : name.endsWith('.jsonl') ? [path] : [];
  });
}

describe('the conversation of a Claude Code transcript', () => {
  it('is read only when asked for, and leaves the events as they are', () => {
    const plain = claudeCode.load(file);
    const full = claudeCode.load(file, { conversation: true });
    expect(plain.main.conversation).toBeUndefined();
    expect(full.main.events).toEqual(plain.main.events);
    expect(full.agents[0]?.transcript.conversation?.length).toBeGreaterThan(0);
  });

  it('holds the prompts, responses, results, and what the harness added, in file order', () => {
    expect(entries().map((e) => (e.kind === 'context' ? `context:${e.source}` : e.kind))).toEqual([
      'context:instructions',
      'prompt',
      'context:reminder',
      'context:memory',
      'context:reminder',
      'response',
      'response',
      'response',
      'result',
      'context:hook',
      'response',
      'response',
      'result',
      'response',
      'result',
      'response',
      'response',
      'result',
      'response',
      'context:message',
      'notice',
      'prompt',
      'context:skill',
      'response',
      'compaction',
      'prompt',
      'response',
      'notice',
      'prompt',
      'response',
    ]);
  });

  it('labels what the harness added by its kind and what it is about', () => {
    const labels = entries().flatMap((e) => (e.kind === 'context' ? [e.label] : []));
    expect(labels).toEqual([
      'Instructions · AGENTS.md, /home/dev/.config/agent/AGENTS.md',
      'System reminder',
      'Memory · src/AGENTS.md',
      'Token budget',
      'Hook · lint-on-read (PostToolUse)',
      'Queued message',
      'Skill',
    ]);
    const hook = entries().find((e) => e.kind === 'context' && e.source === 'hook');
    expect(hook).toMatchObject({
      text: '<system-reminder>PostToolUse hook lint-on-read: Lint passed for src/Checkout.tsx</system-reminder>',
    });
  });

  it('keeps a prompt’s own text apart from the reminders added to it, and counts its images', () => {
    const [first, , , last] = entries().filter((e) => e.kind === 'prompt');
    expect(first).toEqual({
      kind: 'prompt',
      ts: Date.parse('2026-01-05T09:00:01.000Z'),
      by: 'you',
      text: 'Make the checkout button disabled while the order is submitting',
      images: 1,
    });
    expect(last).toMatchObject({ by: 'you', text: '', images: 1 });
  });

  it('reads a command with its arguments, and a task’s report with its summary', () => {
    const prompts = entries().filter((e) => e.kind === 'prompt');
    expect(prompts[1]).toMatchObject({ by: 'command', text: '/review src/Checkout.tsx' });
    expect(prompts[2]).toMatchObject({ by: 'task', summary: 'The watch build finished' });
  });

  it('keeps the reasoning’s text and time, a redacted one, and blocks of other types', () => {
    const blocks = entries().flatMap((e) => (e.kind === 'response' ? e.blocks : []));
    expect(blocks.filter((b) => b.type === 'thinking')).toEqual([
      {
        type: 'thinking',
        text: 'The button lives in src/Checkout.tsx; it needs the submitting state.',
        redacted: false,
        ms: 1800,
      },
      { type: 'thinking', text: '', redacted: true, ms: 900 },
    ]);
    const other = blocks.find((b) => b.type === 'other');
    expect(other?.type === 'other' && other.label).toBe('server_tool_use');
    expect(other?.type === 'other' && JSON.parse(other.text)).toMatchObject({ name: 'web_search' });
  });

  it('reads who let each call run or refused it', () => {
    const results = entries().filter((e) => e.kind === 'result');
    expect(results.map((r) => r.permission)).toEqual([
      { allowed: true, by: 'mode' },
      { allowed: true, by: 'you' },
      { allowed: false, by: 'permission-rule' },
      undefined,
    ]);
    expect(results[3]).toMatchObject({ output: 'The button needs aria-busy while submitting.\n[image]', images: 1 });
  });

  it('marks an API error, and reads notices and a compaction with its summary', () => {
    expect(entries().find((e) => e.kind === 'response' && e.error)).toMatchObject({ synthetic: true });
    expect(entries().filter((e) => e.kind === 'notice')).toEqual([
      {
        kind: 'notice',
        ts: Date.parse('2026-01-05T09:02:20.000Z'),
        level: 'warning',
        text: 'Switched to claude-sonnet-4-5 after an overload',
      },
      {
        kind: 'notice',
        ts: Date.parse('2026-01-05T09:05:10.000Z'),
        level: 'warning',
        text: 'Request interrupted by user',
      },
    ]);
    expect(entries().find((e) => e.kind === 'compaction')).toEqual({
      kind: 'compaction',
      ts: Date.parse('2026-01-05T09:04:00.000Z'),
      trigger: 'auto',
      preTokens: 19800,
      postTokens: 4100,
      summary:
        'This session is being continued from a previous conversation. Summary: the checkout button is disabled while submitting.',
    });
  });

  it('leaves out what the model never saw: the agent’s bookkeeping and the times of turns', () => {
    expect(
      conversationOf(
        [{ type: 'attachment', timestamp: '2026-01-05T09:00:00Z', attachment: { type: 'thinking_drop' } }],
        undefined,
      ),
    ).toEqual([]);
    expect(
      conversationOf([{ type: 'system', subtype: 'turn_duration', timestamp: '2026-01-05T09:00:00Z' }], undefined),
    ).toEqual([]);
  });

  it('starts a turn exactly where the events do, in every fixture', () => {
    const starts = (events: readonly TraceEvent[]): [string, number][] =>
      events.flatMap((e): [string, number][] =>
        e.kind === 'prompt'
          ? [['you', e.ts]]
          : e.kind === 'notification'
            ? [['task', e.ts]]
            : e.kind === 'command'
              ? [['command', e.ts]]
              : [],
      );
    const files = [...transcripts(CLAUDE_CODE_STORE), ...transcripts(CONVERSATION_STORE)];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const t = claudeCode.load(f, { conversation: true }).main;
      const prompts = (t.conversation ?? []).flatMap((e): [string, number][] =>
        e.kind === 'prompt' ? [[e.by, e.ts]] : [],
      );
      expect(prompts, f).toEqual(starts(t.events));
    }
  });

  it('reads the fixtures’ older format, in which plain text is a prompt', () => {
    const records = readRecords(sessionFile('5e9b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'));
    expect(conversationOf(records, '/home/dev/shop').filter((e) => e.kind === 'prompt').length).toBeGreaterThan(0);
  });
});
