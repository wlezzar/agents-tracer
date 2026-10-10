import { describe, expect, it } from 'vitest';

import type { Adapter } from '../src/model/index.js';
import { startServer } from '../src/server/index.js';

import type { ResponseEvent, ToolCall, ToolResultEvent, TraceEvent } from '../src/model/index.js';
import { viewSession, type ModelSpan, type ToolSpan, type ViewData } from '../src/view/index.js';
import { TEST_VIEWER } from './support/cli.js';
import { createMemoryAdapter, session, toolCall, transcript } from './support/memory-adapter.js';

// The view over another agent's session, built in memory: nothing in the view knows Claude Code,
// so its tools are read by category and its shell is named after its own shell tool.

const t0 = Date.UTC(2026, 3, 1, 8, 0);
const at = (s: number) => t0 + s * 1000;

function response(
  ts: number,
  id: string,
  toolCalls: readonly ToolCall[],
  extra: Partial<ResponseEvent> = {},
): ResponseEvent {
  return {
    kind: 'response',
    ts,
    messageId: id,
    model: 'model-a',
    synthetic: false,
    stop: toolCalls.length ? 'tool_use' : 'end_turn',
    usage: { output: 10, cacheRead: 100, cacheWrite: 5, input: 1 },
    blocks: toolCalls.length ? ['tool_use'] : ['text'],
    text: toolCalls.length ? '' : 'done',
    toolCalls,
    ...extra,
  };
}

function result(ts: number, id: string, extra: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    kind: 'tool_result',
    ts,
    toolCallId: id,
    isError: false,
    interrupted: false,
    output: 'ok',
    async: false,
    backgroundIds: [],
    launches: {},
    ...extra,
  };
}

const sh = toolCall('c1', 'run', 'shell', { preview: 'make test', inputText: 'make test', shellCommand: 'make test' });
const ask = toolCall('c2', 'ask', 'question', { preview: 'Which branch?', inputText: '{}' });
const spawn = toolCall('c3', 'spawn', 'agent', { preview: 'review', inputText: '{}', purpose: 'Review it' });
const start = toolCall('c4', 'batch', 'workflow', { preview: 'nightly', inputText: '{}' });

const mainEvents: TraceEvent[] = [
  { kind: 'prompt', ts: at(0), text: 'Test it' },
  response(at(5), 'm1', [sh, ask]),
  result(at(20), 'c1', { output: `${'a'.repeat(1500)}${'z'.repeat(1500)}`, isError: true }),
  result(at(50), 'c2'),
  response(at(60), 'm2', [spawn, start]),
  result(at(61), 'c3', { async: true, backgroundIds: ['agent-1'], launches: { agentId: 'agent-1' } }),
  result(at(62), 'c4', { launches: { groupId: 'run-1' } }),
  response(at(70), 'm3', []),
];

const agentEvents = (offset: number): TraceEvent[] => [
  { kind: 'prompt', ts: at(offset), text: 'Review it' },
  response(at(offset + 10), `a${offset}`, [], { stop: null }),
];

const full = session(
  transcript('neutral-1', mainEvents, {
    title: 'Neutral',
    cwd: '/home/dev/app',
    compactions: [{ preTokens: 9000, trigger: 'auto' }],
  }),
  {
    shellToolName: 'run',
    agents: [
      {
        id: 'agent-2',
        transcript: transcript('agent-2', agentEvents(65)),
        background: false,
        group: 'run-1',
        phase: 'plan',
      },
      {
        id: 'agent-1',
        transcript: transcript('agent-1', agentEvents(62)),
        background: true,
        group: null,
        description: 'Review it',
      },
      { id: 'agent-3', transcript: transcript('agent-3', []), background: false, group: null },
    ],
    groups: [{ id: 'run-1', kind: 'Batch', label: 'Batch nightly', name: 'nightly', status: 'done', durationMs: 9000 }],
  },
);

function toolSpans(data: ViewData, lane = 0): ToolSpan[] {
  return (data.lanes[lane]?.spans ?? []).filter((s): s is ToolSpan => s.t === 't');
}

describe('the view of another agent’s session', () => {
  const data = viewSession(full, { now: 42 });
  const [main] = data.lanes;

  it('names the shell after the agent’s shell tool and maps every tool to its category', () => {
    expect(data.shellLabel).toBe('run');
    expect(data.toolCategories).toEqual({ run: 'shell', ask: 'question', spawn: 'agent', batch: 'workflow' });
    expect(toolSpans(data).map((s) => [s.name, s.cat])).toEqual([
      ['run', 'shell'],
      ['ask', 'question'],
      ['spawn', 'agent'],
      ['batch', 'workflow'],
    ]);
    expect(viewSession(session(transcript('x', mainEvents))).shellLabel).toBe('Shell');
  });

  it('describes the session, and stamps the build time', () => {
    expect(data.session).toEqual({ id: 'neutral-1', title: 'Neutral', cwd: '/home/dev/app', file: 'memory:neutral-1' });
    expect(data.generated).toBe(42);
    expect(data.serve).toBeUndefined();
    expect(viewSession(full, { serve: true }).serve).toBe(true);
  });

  it('groups the lanes: the session, the agents on their own, then each group by start, with its kind', () => {
    expect(data.groups).toEqual([
      { id: 'main', label: 'Session' },
      // agent-3 has no events, so the group's first start is NaN, which JSON writes as null.
      { id: 'agents', label: 'Agents', start: null },
      {
        id: 'run-1',
        label: 'Batch nightly',
        kind: 'Batch',
        status: 'done',
        ms: 9000,
        tokens: null,
        toolCalls: null,
        start: at(65),
      },
    ]);
  });

  it('puts the main lane first, then the agents by start, each placed under its launcher', () => {
    expect(data.lanes.map((l) => [l.id, l.label, l.group, l.parent, l.nested])).toEqual([
      ['main', 'Main session', 'main', null, undefined],
      ['agent-1', 'Review it', 'agents', 'main', false],
      ['agent-2', 'agent-2', 'run-1', 'main', false],
      ['agent-3', 'agent-3', 'agents', null, false],
    ]);
    expect(data.lanes[2]).toMatchObject({ phase: 'plan', agentType: null, background: false });
    expect(data.lanes[1]).toMatchObject({ phase: null, background: true });
  });

  it('sorts the spans by start, a model call before the tool calls it asked for, and links them by index', () => {
    expect(main?.spans.map((s) => [s.t, s.s])).toEqual([
      ['m', at(0)],
      ['t', at(5)],
      ['t', at(5)],
      ['m', at(50)],
      ['t', at(60)],
      ['t', at(60)],
      ['m', at(62)],
    ]);
    const models = (main?.spans ?? []).filter((s): s is ModelSpan => s.t === 'm');
    expect(models.map((m) => m.tools)).toEqual([[1, 2], [4, 5], []]);
    expect(models[0]).toMatchObject({
      ms: 5000,
      out: 10,
      cr: 100,
      cw: 5,
      stop: 'tool_use',
      sum: 'run make test · ask Which branch?',
    });
  });

  it('keeps a tool call’s result, clipped to its head and tail, and what it launched', () => {
    const [run, , spawned, batch] = toolSpans(data);
    expect(run).toMatchObject({ ms: 15000, err: true, intr: false, pv: 'make test', in: 'make test', turn: 1 });
    expect(run?.out).toBe(`${'a'.repeat(1000)}\n\n… 1000 characters left out …\n\n${'z'.repeat(1000)}`);
    expect(spawned).toMatchObject({ desc: 'Review it', async: true, agent: 'agent-1', run: null, bgEnd: null });
    expect(batch).toMatchObject({ agent: null, run: 'run-1' });
  });

  it('sums the lane’s time, with token counts only where usage is known', () => {
    expect(main?.stats).toMatchObject({
      wall: 70000,
      calls: 3,
      toolCalls: 4,
      out: 30,
      cacheRead: 300,
      models: ['model-a'],
      compactions: [{ pre: 9000, trigger: 'auto' }],
    });
    expect(main?.bash).toEqual([['make', 15000, 1, 15000, 1]]);
    expect(data.lanes[1]?.stats).toMatchObject({ out: null, cacheRead: null, cacheWrite: null });
    // A transcript without events has no start or end, and a wall time JSON writes as null.
    expect(data.lanes[3]).toMatchObject({ stats: { wall: null, active: 0 } });
    expect(data.lanes[3]?.start).toBeUndefined();
  });

  it('loads through the adapter like any other session', () => {
    const adapter = createMemoryAdapter([full]);
    expect(viewSession(adapter.load(adapter.resolve('memory:', 'neutral'))).lanes).toHaveLength(4);
  });
});

describe('another agent’s sessions, served', () => {
  /** Serves `adapter`'s sessions, fetches each path, and says how many pages it built. */
  async function serve(adapter: Adapter, paths: readonly string[]): Promise<{ bodies: string[]; renders: number }> {
    let renders = 0;
    const server = await startServer({
      adapter,
      store: 'memory:',
      port: 0,
      viewer: () => {
        renders++;
        return TEST_VIEWER;
      },
    });
    try {
      const bodies: string[] = [];
      for (const path of paths) {
        const res = await fetch(new URL(path, server.url));
        expect(res.status).toBe(200);
        bodies.push(await res.text());
      }
      return { bodies, renders };
    } finally {
      await server.close();
    }
  }
  const embedded = (html: string): unknown => JSON.parse(/application\/json">(.*)<\/script>/s.exec(html)?.[1] ?? '');

  it('lists them and serves each by id, though the session is no file', async () => {
    const { bodies, renders } = await serve(createMemoryAdapter([full]), ['/', '/s/neutral-1', '/s/neutral-1']);
    const [index, page] = bodies;
    expect(embedded(index ?? '')).toMatchObject({
      index: { agent: 'Memory', sessions: [{ id: 'neutral-1', title: 'Neutral', first: 'Test it' }] },
    });
    expect(embedded(page ?? '')).toMatchObject({ serve: true, shellLabel: 'run', session: { id: 'neutral-1' } });
    expect(renders).toBe(2); // the index, then the session's page once: its version never changes
  });

  it('lists a session whose id cannot be in a URL without a link', async () => {
    const dotted = session(transcript('run.2026-01-05', mainEvents));
    const { bodies } = await serve(createMemoryAdapter([full, dotted]), ['/']);
    expect(embedded(bodies[0] ?? '')).toMatchObject({
      index: {
        sessions: [
          { id: 'neutral-1', href: '/s/neutral-1' },
          { id: 'run.2026-01-05', href: null },
        ],
      },
    });
  });

  it('builds the page on every request for an adapter without a version', async () => {
    const memory = createMemoryAdapter([full]);
    const unversioned: Adapter = {
      id: memory.id,
      displayName: memory.displayName,
      defaultStore: (cwd, home) => memory.defaultStore(cwd, home),
      listSessions: (store) => memory.listSessions(store),
      resolve: (store, ref, options) => memory.resolve(store, ref, options),
      load: (path, options) => memory.load(path, options),
    };
    const { renders } = await serve(unversioned, ['/s/neutral-1', '/s/neutral-1']);
    expect(renders).toBe(2);
  });
});
