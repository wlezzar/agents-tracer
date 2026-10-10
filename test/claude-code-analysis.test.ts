import { describe, expect, it } from 'vitest';

import { registry } from '../src/adapters/registry.js';
import {
  activeOf,
  analyzeSession,
  shellBreakdown,
  sumTools,
  usageKnown,
  usageTotals,
  wallOf,
  type TranscriptAnalysis,
} from '../src/analysis/index.js';
import { CLAUDE_CODE_STORE as store, SESSIONS } from './support/fixtures.js';

// The fixture store through the shipped adapter and the analysis. The expected numbers are the
// prototype's (session-trace/trace.mjs) for the same files.

const adapter = registry.get('claude-code');
const load = (ref: string) => analyzeSession(adapter.load(adapter.resolve(store, ref)));
const all = adapter.listSessions(store).map((s) => load(s.id));
const transcripts: TranscriptAnalysis[] = all.flatMap((s) => [s.main, ...s.agents.map((a) => a.analysis)]);

describe('every fixture transcript', () => {
  it.each(transcripts.map((a) => [a.transcript.id, a] as const))('%s: segments partition its time', (_, a) => {
    const [first] = a.segments;
    const last = a.segments.at(-1);
    expect(first?.[0]).toBe(a.start);
    expect(last?.[1]).toBe(a.end);
    a.segments.forEach(([start, end], i) => {
      expect(end).toBeGreaterThan(start);
      if (i > 0) expect(start).toBe(a.segments[i - 1]?.[1]);
    });
    const sums = new Map<string, number>();
    for (const [start, end, bucket] of a.segments) sums.set(bucket, (sums.get(bucket) ?? 0) + end - start);
    expect(Object.fromEntries(sums)).toEqual(Object.fromEntries(a.buckets));
  });

  it.each(transcripts.map((a) => [a.transcript.id, a] as const))('%s: turns hold its active time', (_, a) => {
    const turnTime = a.turns.reduce((sum, t) => sum + activeOf(t.buckets), 0);
    expect(turnTime).toBe(activeOf(a.buckets));
  });
});

describe('the cart badge session', () => {
  const { main, agents } = load(SESSIONS.badge);

  it('charges its time as the prototype does', () => {
    expect([...main.buckets]).toEqual([
      ['idle: waiting on you', 3140050],
      ['model', 228850],
      ['tool:Grep', 500],
      ['tool:Read', 500],
      ['tool:Edit', 700],
      ['tool:Bash', 212000],
      ['you: answering questions', 120000],
      ['tool:Write', 200],
      ['idle: waiting on you, background tasks running', 1394900],
      ['tool:TaskStop', 300],
      ['tool:Agent', 1000],
      ['idle: waiting on a background task', 380000],
      ['tool:Workflow', 1000],
    ]);
    expect(activeOf(main.buckets)).toBe(565050);
    expect(sumTools(main.buckets)).toBe(216200);
    expect(wallOf(main)).toBe(5480000);
    expect([main.calls.length, main.tools.length, main.segments.length]).toEqual([21, 16, 46]);
    expect(main.models).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5']);
  });

  it('knows its usage', () => {
    expect(usageKnown(main.calls)).toBe(true);
    expect(usageTotals(main.calls)).toEqual({ output: 2165, cacheRead: 390270, cacheWrite: 35020, input: 47 });
  });

  it('has the prototype’s turns', () => {
    expect(main.turns.map((t) => [t.n, t.kind, t.text, activeOf(t.buckets), t.calls, t.tools, t.out])).toEqual([
      [1, 'command', '/clear', 0, 0, 0, 0],
      [2, 'you', 'Add a cart badge to the header that shows how many items are in the cart', 310000, 8, 8, 1430],
      [3, 'you', 'Look at the design mock and run the e2e tests', 70050, 2, 2, 135],
      [4, 'you', 'Stop the dev server, build in the background, and have an agent review the badge', 100000, 5, 4, 325],
      [5, 'task', 'Agent "Review the cart badge" completed', 20000, 2, 1, 150],
      [6, 'you', 'Run the add-tests workflow for the badge', 15000, 2, 1, 77],
      [7, 'you', 'Thanks. Summarize what changed.', 30000, 1, 0, 0],
      [8, 'you', 'Try again', 20000, 1, 0, 48],
    ]);
  });

  it('tracks errors, interruptions, and background tasks', () => {
    const byId = new Map(main.tools.map((t) => [t.id, t]));
    expect(byId.get('toolu_a04')).toMatchObject({ isError: true, interrupted: false, ms: 45000 });
    expect(byId.get('toolu_a10')).toMatchObject({ isError: true, interrupted: true, ms: 60000 });
    expect(byId.get('toolu_a09')?.output).toBe('[image]');
    expect(byId.get('toolu_a07')).toMatchObject({ async: true, backgroundIds: ['bk3m9x'] });
    expect(byId.get('toolu_a07')?.bgEnd).toBeUndefined();
    expect(byId.get('toolu_a12')).toMatchObject({
      async: true,
      bgEnd: Date.parse('2026-03-14T23:19:59.900Z'),
      launches: { agentId: 'a1b2c3d4e5f6a7b8c' },
    });
    expect(byId.get('toolu_a13')?.bgEnd).toBe(Date.parse('2026-03-14T23:13:00.000Z'));
    expect(byId.get('toolu_a16')).toMatchObject({ async: true, launches: { groupId: 'wf_3e9a1c7b-5d2' } });
    expect(main.calls.filter((c) => c.synthetic).map((c) => c.messageId)).toEqual(['msg_a20']);
  });

  it('groups its shell calls by command', () => {
    expect(shellBreakdown(main.tools).map((r) => [r.key, r.ms, r.calls, r.max, r.failed])).toEqual([
      ['pnpm test', 90000, 2, 45000, 1],
      ['pnpm exec playwright', 60000, 1, 60000, 1],
      ['pnpm lint', 60000, 1, 60000, 0],
      ['pnpm dev [bg]', 1000, 1, 1000, 0],
      ['pnpm build [bg]', 1000, 1, 1000, 0],
    ]);
  });

  it('places its agents', () => {
    const placed = [...agents].sort((a, b) => a.agent.id.localeCompare(b.agent.id));
    expect(placed.map((a) => [a.agent.id, a.parent, a.nested, a.launcher?.id])).toEqual([
      ['a1b2c3d4e5f6a7b8c', 'main', false, 'toolu_a12'],
      ['a9f8e7d6c5b4a3921', 'a1b2c3d4e5f6a7b8c', true, undefined],
      ['ab12cd34ef56ab78c', 'main', false, undefined],
      ['ac98ba76dc54fe32a', 'main', false, undefined],
    ]);
    expect(placed.map((a) => [usageKnown(a.analysis.calls), a.analysis.calls.length])).toEqual([
      [false, 3],
      [true, 3],
      [true, 2],
      [true, 3],
    ]);
  });
});

describe('the older-format session', () => {
  const { main } = load(SESSIONS.oldFormat);

  it('reads plain text as prompts and charges its time as the prototype does', () => {
    expect(main.turns.map((t) => [t.kind, t.text])).toEqual([
      ['you', 'Add a test for the cart total'],
      ['command', '/model'],
      ['you', 'Now run it'],
    ]);
    expect([...main.buckets]).toEqual([
      ['model', 65090],
      ['tool:Bash', 31000],
      ['tool:WebFetch', 2500],
      ['tool:Skill', 100],
      ['tool:mcp__shop-db__query', 1000],
      ['tool:Write', 300],
      ['idle: waiting on you', 300000],
    ]);
    expect(shellBreakdown(main.tools).map((r) => r.key)).toEqual(['pnpm test', 'git log']);
  });
});

describe('the compaction session', () => {
  const { main } = load(SESSIONS.compaction);

  it('charges the compaction to its command, and reads up to the partial last line', () => {
    expect([...main.buckets]).toEqual([
      ['model', 57500],
      ['tool:Read', 200],
      ['idle: waiting on you', 1060500],
      ['compaction', 89500],
      ['tool:Edit', 300],
    ]);
    expect(main.turns.map((t) => [t.kind, t.text, activeOf(t.buckets)])).toEqual([
      ['you', 'Refactor the cart store to use a reducer', 30000],
      ['command', '/compact', 89500],
      ['you', '[peer] The docs session asks: please update docs/cart.md for the reducer too.', 20000],
      ['you', 'Also add an undo action', 8000],
    ]);
    expect(main.end).toBe(Date.parse('2026-03-12T14:20:08.000Z'));
  });
});
