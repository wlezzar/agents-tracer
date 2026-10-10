import { describe, expect, it } from 'vitest';

import type { AgentTranscript, ToolResultEvent, TraceEvent } from '../model/index.js';
import { session, toolCall, transcript } from '../../test/support/memory-adapter.js';
import { analyzeSession } from './session.js';
import { MAIN } from './types.js';

// Where each agent of a session sits: who launched it, and whether that was another agent.

const t0 = Date.UTC(2026, 2, 14, 9, 0);

/** A transcript whose agent calls launch the given agent ids, one call each. */
function launching(id: string, agentIds: readonly string[]): TraceEvent[] {
  return [
    { kind: 'prompt', ts: t0, text: 'go' },
    ...agentIds.flatMap((agentId, i): TraceEvent[] => {
      const callId = `${id}-call-${i}`;
      const launched: ToolResultEvent = {
        kind: 'tool_result',
        ts: t0 + 2 * i + 2,
        toolCallId: callId,
        isError: false,
        interrupted: false,
        output: '',
        async: true,
        backgroundIds: [agentId],
        launches: { agentId },
      };
      return [
        {
          kind: 'response',
          ts: t0 + 2 * i + 1,
          messageId: `${id}-m${i}`,
          synthetic: false,
          stop: 'tool_use',
          blocks: ['tool_use'],
          text: '',
          toolCalls: [toolCall(callId, 'Spawn', 'agent')],
        },
        launched,
      ];
    }),
  ];
}

const agent = (id: string, events: TraceEvent[], group: string | null = null): AgentTranscript => ({
  id,
  transcript: transcript(`agent-${id}`, events),
  background: false,
  group,
});

describe('analyzeSession', () => {
  const s = session(transcript('main', launching('main', ['x', 'x', 'w'])), {
    agents: [
      agent('x', launching('x', ['y'])),
      agent('y', []),
      agent('z', [], 'run-1'),
      agent('w', [], 'run-1'),
      agent('loose', []),
    ],
    groups: [{ id: 'run-1', kind: 'Run', label: 'Run' }],
  });
  const analyzed = analyzeSession(s);

  it('analyzes the main transcript and every agent’s, in the session’s order', () => {
    expect(analyzed.session).toBe(s);
    expect(analyzed.main.transcript.id).toBe('main');
    expect(analyzed.main.tools).toHaveLength(3);
    expect(analyzed.agents.map((a) => [a.agent.id, a.analysis.transcript.id])).toEqual([
      ['x', 'agent-x'],
      ['y', 'agent-y'],
      ['z', 'agent-z'],
      ['w', 'agent-w'],
      ['loose', 'agent-loose'],
    ]);
  });

  it('places each agent under the transcript that launched it', () => {
    expect(analyzed.agents.map((a) => [a.agent.id, a.parent, a.nested])).toEqual([
      ['x', MAIN, false],
      ['y', 'x', true],
      ['z', MAIN, false],
      ['w', MAIN, false],
      ['loose', null, false],
    ]);
  });

  it("names the main transcript's call that launched an agent, the last when several did", () => {
    expect(analyzed.agents.map((a) => [a.agent.id, a.launcher?.id])).toEqual([
      ['x', 'main-call-1'],
      ['y', undefined],
      ['z', undefined],
      ['w', 'main-call-2'],
      ['loose', undefined],
    ]);
  });

  it('passes the options to every transcript', () => {
    const idle: TraceEvent[] = [
      { kind: 'prompt', ts: t0, text: 'a' },
      {
        kind: 'response',
        ts: t0 + 1,
        messageId: 'm',
        synthetic: false,
        stop: 'end_turn',
        blocks: [],
        text: '',
        toolCalls: [],
      },
      { kind: 'prompt', ts: t0 + 3001, text: 'b' },
    ];
    const both = session(transcript('main', idle), { agents: [agent('a', idle)] });
    const idleItems = (minIdle: number) => {
      const a = analyzeSession(both, { minIdle });
      return [a.main, a.agents[0]?.analysis].map((x) => x?.timeline.filter((i) => i.kind === 'idle').length);
    };
    expect(idleItems(1)).toEqual([1, 1]);
    expect(idleItems(5)).toEqual([0, 0]);
  });
});
