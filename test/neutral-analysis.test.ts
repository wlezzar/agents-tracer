import { describe, expect, it } from 'vitest';

import {
  activeOf,
  analyzeSession,
  callSummary,
  shellBreakdown,
  topTools,
  usageKnown,
  youOf,
} from '../src/analysis/index.js';
import type { ToolResultEvent, TraceEvent } from '../src/model/index.js';
import { createMemoryAdapter, session, toolCall, transcript } from './support/memory-adapter.js';

// The analysis without Claude Code: a session of another agent, with its own tool names, served
// by the test-only memory adapter. Everything is decided by the tools' categories.

const t0 = Date.UTC(2026, 2, 20, 10, 0);
const at = (s: number): number => t0 + s * 1000;
const usage = { output: 100, cacheRead: 1000, cacheWrite: 10, input: 5 };

const result = (
  s: number,
  toolCallId: string,
  extra: Partial<Omit<ToolResultEvent, 'kind' | 'ts'>> = {},
): TraceEvent => ({
  kind: 'tool_result',
  ts: at(s),
  toolCallId,
  isError: false,
  interrupted: false,
  output: '',
  async: false,
  backgroundIds: [],
  launches: {},
  ...extra,
});
const reply = (
  s: number,
  messageId: string,
  extra: Partial<Extract<TraceEvent, { kind: 'response' }>> = {},
): TraceEvent => ({
  kind: 'response',
  ts: at(s),
  messageId,
  model: 'other-model-1',
  synthetic: false,
  stop: 'end_turn',
  usage,
  blocks: ['text'],
  text: '',
  toolCalls: [],
  ...extra,
});

const runCommand = (id: string, command: string, background = false) =>
  toolCall(id, 'run_command', 'shell', {
    preview: command,
    inputText: command,
    shellCommand: command,
    ...(background && { runsInBackground: true }),
  });

const events: TraceEvent[] = [
  { kind: 'prompt', ts: at(0), text: 'Make the build faster' },
  reply(3, 'r1', { stop: 'tool_use', toolCalls: [runCommand('c1', 'npm run build')] }),
  result(63, 'c1'),
  reply(65, 'r2', {
    stop: 'tool_use',
    toolCalls: [toolCall('c2', 'ask_human', 'question', { preview: 'Cache in CI?' })],
  }),
  result(95, 'c2'),
  reply(97, 'r3', { stop: 'tool_use', toolCalls: [runCommand('c3', 'npm run watch', true)] }),
  result(98, 'c3', { async: true, backgroundIds: ['job-7'] }),
  reply(100, 'r4', {
    stop: 'tool_use',
    toolCalls: [toolCall('c4', 'cancel_job', 'task-control', { preview: 'job-7', stops: ['job-7'] })],
  }),
  result(101, 'c4'),
  reply(110, 'r5', { text: 'The build now caches its dependencies.' }),
  { kind: 'prompt', ts: at(170), text: 'Thanks' },
];

const adapter = createMemoryAdapter([
  session(transcript('other-1', events, { title: 'Faster build' }), { shellToolName: 'run_command' }),
]);

describe('the analysis of another agent’s session', () => {
  const analyzed = analyzeSession(adapter.load(adapter.resolve('memory:', 'other')));
  const { main } = analyzed;

  it('charges its time by tool category, not by Claude Code’s tool names', () => {
    expect(Object.fromEntries(main.buckets)).toEqual({
      model: 18000,
      'tool:run_command': 61000,
      'you: answering questions': 30000,
      'tool:cancel_job': 1000,
      'idle: waiting on you': 60000,
    });
    expect(activeOf(main.buckets)).toBe(110000);
    expect(youOf(main.buckets)).toBe(90000);
    expect(topTools(main.buckets)).toBe('run_command 1m01s, you: answering questions 30s, cancel_job 1.0s');
  });

  it('stops the background task its task-control call names', () => {
    const [last] = main.segments.slice(-1);
    expect(last).toEqual([at(110), at(170), 'idle: waiting on you']);
  });

  it('groups its shell calls by command', () => {
    expect(shellBreakdown(main.tools).map((r) => [r.key, r.ms, r.calls])).toEqual([
      ['npm run build', 60000, 1],
      ['npm run watch [bg]', 1000, 1],
    ]);
  });

  it('counts its calls and turns', () => {
    expect(usageKnown(main.calls)).toBe(true);
    expect(main.calls.map(callSummary)).toEqual([
      'run_command npm run build',
      'ask_human Cache in CI?',
      'run_command npm run watch',
      'cancel_job job-7',
      '“The build now caches its dependencies.”',
    ]);
    expect(main.turns.map((t) => [t.kind, t.text, t.calls, t.tools, t.out])).toEqual([
      ['you', 'Make the build faster', 5, 4, 500],
      ['you', 'Thanks', 0, 0, 0],
    ]);
    expect(analyzed.agents).toEqual([]);
  });
});
