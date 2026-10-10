import { describe, expect, it } from 'vitest';

import { analyzeSession } from '../src/analysis/index.js';
import type { Group, Session, ToolResultEvent, TraceEvent } from '../src/model/index.js';
import { report, sessionList } from '../src/report/index.js';
import { session, toolCall, transcript } from './support/memory-adapter.js';

// The report without Claude Code: a session of another agent, with its own tool names, its own
// shell tool, and its own kind of agent group, built in memory. Times are in Europe/Paris, where
// the tests run: 09:00 UTC is 10:00.

const t0 = Date.UTC(2026, 2, 20, 9, 0);
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
const runCommand = (id: string, command: string) =>
  toolCall(id, 'run_command', 'shell', { preview: command, inputText: command, shellCommand: command });

const main = transcript(
  'session-1',
  [
    { kind: 'prompt', ts: at(0), text: 'Make the build faster' },
    reply(3, 'r1', {
      stop: 'tool_use',
      blocks: ['thinking', 'tool_use'],
      toolCalls: [runCommand('c1', 'npm run build')],
    }),
    result(63, 'c1', { isError: true }),
    reply(65, 'r2', {
      stop: 'tool_use',
      toolCalls: [toolCall('c2', 'ask_human', 'question', { preview: 'Cache in CI?' })],
    }),
    result(95, 'c2'),
    reply(97, 'r3', {
      stop: 'tool_use',
      toolCalls: [toolCall('c3', 'spawn', 'agent', { preview: 'Profile the build' })],
    }),
    result(98, 'c3', { async: true, launches: { agentId: 'helper-1' }, backgroundIds: ['helper-1'] }),
    reply(110, 'r4', { text: 'The build now caches its dependencies.' }),
    { kind: 'prompt', ts: at(400), text: 'Thanks' },
    reply(402, 'r5', { text: 'You are welcome.' }),
  ],
  { title: 'Faster builds', compactions: [{ preTokens: 1500, postTokens: 200, durationMs: 4000, trigger: 'auto' }] },
);

// Written mid-stream: no stop reasons, so its token counts are unknown.
const helper = transcript('helper-1', [
  { kind: 'prompt', ts: at(99), text: 'Profile the build' },
  reply(120, 'h1', { stop: null, toolCalls: [runCommand('h-c1', 'npm run build -- --profile')] }),
  result(180, 'h-c1'),
  reply(190, 'h2', { stop: null, text: 'The bundler takes most of the time.' }),
]);
const checker = transcript('checker-a', [
  { kind: 'prompt', ts: at(200), text: 'Check the lockfile' },
  reply(230, 'b1', { text: 'The lockfile is fine.' }),
]);

const nightly: Group = {
  id: 'night-7',
  kind: 'Batch',
  label: 'Batch nightly',
  name: 'nightly',
  status: 'done',
  durationMs: 45000,
  totalTokens: 1200,
};
const build = (extra: { shellToolName?: string; group?: Group } = {}): Session =>
  session(main, {
    ...(extra.shellToolName !== undefined && { shellToolName: extra.shellToolName }),
    agents: [
      { id: 'helper-1', transcript: helper, description: 'Profile the build', background: true, group: null },
      {
        id: 'checker-a',
        transcript: checker,
        phase: 'check',
        description: 'Check the lockfile',
        background: false,
        group: 'night-7',
      },
    ],
    groups: [extra.group ?? nightly],
  });
const analyzed = analyzeSession(build({ shellToolName: 'run_command' }));

const summaryLines = [
  'session-1  “Faster builds”',
  '  2026-03-20 10:00 → 2026-03-20 10:06  ·  6m42s wall  ·  1m52s active',
  '  5 API calls (other-model-1)  ·  3 tool calls  ·  500 output, 5.0k cache-read, 50 cache-write, 25 uncached input tokens',
  '  1 compactions: 1.5k→200 in 4.0s (auto)',
  '',
  'Where the time went',
  '                                                   time  active  count',
  '  tool:run_command                                1m00s     54%  1',
  '  you: answering questions                          30s     27%  1',
  '  model                                             21s     19%  5',
  '  tool:spawn                                       1.0s      1%  1',
  '  idle: waiting on you, background tasks running  4m50s',
  '',
  'run_command by command (sum of call durations)',
  '                  time  calls    max  failed',
  '  npm run build  1m00s      1  1m00s  1',
  '',
  'Slowest tool calls',
  '  #1  10:00:03  1m00s  run_command  npm run build  ✗',
  '  #1  10:01:05    30s  ask_human    Cache in CI?',
  '  #1  10:01:37   1.0s  spawn        Profile the build',
  '',
  'Slowest model responses',
  '  #1  10:01:50   12s  100 out  “The build now caches its dependencies.”',
  '  #1  10:00:03  3.0s  100 out  thinking · run_command npm run build',
  '  #1  10:01:05  2.0s  100 out  ask_human Cache in CI?',
  '  #1  10:01:37  2.0s  100 out  spawn Profile the build',
  '  #2  10:06:42  2.0s  100 out  “You are welcome.”',
  '',
  'Turns (active time only; idle time is between turns)',
  '      start     by   active  model  tools  calls  tools#  top tools                                        prompt',
  '  #1  10:00:00  you   1m50s    19s  1m01s      4       3  run_command 1m00s, you: answering questions 30s  Make the build faster',
  '  #2  10:06:40  you    2.0s   2.0s   0.0s      1       0                                                   Thanks',
];
const subagentLines = [
  '',
  'Subagents (they run alongside the session, so their time overlaps it)',
  '  start      wall  model  tools  calls  out  top tools          agent',
  '  10:01:39  1m31s    31s  1m00s      2    -  run_command 1m00s  Profile the build [background, helper-1]',
  '',
  '  Batch nightly night-7 · done · 45s · 1 agents · 1.2k tokens',
  '    start     wall  model  tools  calls  out  top tools  agent',
  '    10:03:20   30s    30s   0.0s      1  100             check: Check the lockfile [checker-a]',
];
const timelineLines = [
  '',
  '── #1 10:00:00 you: Make the build faster',
  '10:00:03    3.0s  model        100 out  thinking · run_command npm run build',
  '10:01:03   1m00s  run_command npm run build  ✗',
  '10:01:05    2.0s  model        100 out  ask_human Cache in CI?',
  '10:01:35     30s  ask_human  Cache in CI?',
  '10:01:37    2.0s  model        100 out  spawn Profile the build',
  '10:01:38    1.0s  spawn      Profile the build  [async]',
  '10:01:50     12s  model        100 out  “The build now caches its dependencies.”',
  '10:06:40   4m50s  … waiting on you, background tasks running',
  '',
  '── #2 10:06:40 you: Thanks',
  '10:06:42    2.0s  model        100 out  “You are welcome.”',
];

describe('the report on another agent’s session', () => {
  it('prints the summary and the subagents, by the tools’ categories and the session’s names', () => {
    expect(report(analyzed)).toBe([...summaryLines, ...subagentLines].join('\n'));
  });

  it('adds the timeline', () => {
    expect(report(analyzed, { timeline: true })).toBe([...summaryLines, ...subagentLines, ...timelineLines].join('\n'));
  });

  it('shows one turn of the timeline', () => {
    const text = report(analyzed, { timeline: true, turn: 2, subagents: false });
    expect(text).toBe([...summaryLines, ...timelineLines.slice(-3)].join('\n'));
  });

  it('leaves out the subagents', () => {
    expect(report(analyzed, { subagents: false })).toBe(summaryLines.join('\n'));
  });

  it('cuts the shell breakdown and the slowest tables to the top rows, keeping the shell title', () => {
    const lines = report(analyzed, { top: 0, subagents: false }).split('\n');
    expect(lines).toContain('run_command by command (sum of call durations)');
    expect(lines).not.toContain('Slowest tool calls');
    expect(lines).not.toContain('Slowest model responses');
    const top1 = report(analyzed, { top: 1, subagents: false }).split('\n');
    expect(top1.filter((l) => l.startsWith('  #1  10:0'))).toEqual([
      '  #1  10:00:03  1m00s  run_command  npm run build  ✗',
      '  #1  10:01:50  12s  100 out  “The build now caches its dependencies.”',
      '  #1  10:00:00  you   1m50s    19s  1m01s      4       3  run_command 1m00s, you: answering questions 30s  Make the build faster',
    ]);
  });

  it('titles the shell breakdown Shell when the agent names no shell tool', () => {
    const lines = report(analyzeSession(build())).split('\n');
    expect(lines).toContain('Shell by command (sum of call durations)');
  });

  it('heads a group without a summary with its kind and question marks', () => {
    const bare: Group = { id: 'night-7', kind: 'Batch', label: 'Batch' };
    const lines = report(analyzeSession(build({ group: bare }))).split('\n');
    expect(lines).toContain('  Batch ? night-7 · ? · - · 1 agents');
  });
});

describe('the report’s edge cases, as the prototype printed them', () => {
  it('prints a compaction field the agent left out as undefined', () => {
    const t = transcript('s', [{ kind: 'prompt', ts: at(0), text: 'Go' }], { compactions: [{ preTokens: 900 }] });
    const lines = report(analyzeSession(session(t))).split('\n');
    expect(lines[3]).toBe('  1 compactions: 900→undefined in - (undefined)');
  });

  it('prints a transcript without events', () => {
    expect(report(analyzeSession(session(transcript('empty', []))))).toBe(
      [
        'empty',
        '  NaN-NaN-NaN NaN:NaN → NaN-NaN-NaN NaN:NaN  ·  - wall  ·  0.0s active',
        '  0 API calls (no model)  ·  0 tool calls  ·  tokens not recorded (subagent transcript)',
        '',
        'Where the time went',
        '    time  active  count',
      ].join('\n'),
    );
  });
});

describe('the session list', () => {
  it('prints each session’s short id, start, wall time, size, and title or first prompt', () => {
    const text = sessionList([
      { id: '0a1b2c3d-1111', path: 'a', start: at(0), end: at(4000), size: 120_000, title: 'Faster builds' },
      {
        id: '9f8e7d6c-2222',
        path: 'b',
        start: at(86_400),
        end: at(86_405),
        size: 900,
        firstPrompt: 'Fix   the\nlogin',
      },
      { id: '5a5a5a5a-3333', path: 'c', start: at(90_000), end: at(90_000), size: 0 },
    ]);
    expect(text).toBe(
      [
        'session   start              wall  size  title / first prompt',
        '0a1b2c3d  2026-03-20 10:00  1h07m  117K  Faster builds',
        '9f8e7d6c  2026-03-21 10:00   5.0s    1K  Fix the login',
        '5a5a5a5a  2026-03-21 11:00   0.0s    0K',
      ].join('\n'),
    );
  });

  it('prints only its header without sessions', () => {
    expect(sessionList([])).toBe('session  start  wall  size  title / first prompt');
  });
});
