import type { StopReason, ToolDescription, TraceEvent, Transcript, Usage } from '../model/index.js';
import { bucketOf, isIdle } from './aggregates.js';
import type {
  AnalyzeOptions,
  Bucket,
  IdleBucket,
  ModelCall,
  TimelineItem,
  ToolRun,
  TranscriptAnalysis,
  Turn,
  TurnKind,
} from './types.js';

// The timing state machine, ported from the prototype's analyze: it walks a transcript's events in
// time order and charges each gap between consecutive events to what was pending. docs/model.md
// describes the rules.

type State = 'start' | 'model' | 'tools' | 'idle' | 'compaction';

// The mutable records the walk fills in, returned as the readonly types.

interface TurnState extends Turn {
  readonly buckets: Map<Bucket, number>;
  calls: number;
  tools: number;
  out: number;
  end: number;
}

interface RunState extends ToolRun {
  end?: number;
  ms?: number;
  isError: boolean;
  interrupted: boolean;
  async: boolean;
  bgEnd?: number;
  output: string;
  launches: { readonly agentId?: string; readonly groupId?: string };
  backgroundIds: readonly string[];
}

interface CallState extends ModelCall {
  end: number;
  ms: number;
  usage?: Usage;
  stop: StopReason | null;
  readonly blocks: string[];
  text: string;
  readonly tools: RunState[];
}

const WAITING_ON_TASK: IdleBucket = 'idle: waiting on a background task';
const WAITING_WITH_TASKS: IdleBucket = 'idle: waiting on you, background tasks running';
const WAITING: IdleBucket = 'idle: waiting on you';

/** The events in time order, file order between equal times. */
function sorted(events: readonly TraceEvent[]): TraceEvent[] {
  return events
    .map((event, seq) => ({ event, seq }))
    .sort((a, b) => a.event.ts - b.event.ts || a.seq - b.seq)
    .map(({ event }) => event);
}

/** Analyzes one transcript: buckets, segments, model calls, tool calls, turns, and the timeline. */
export function analyzeTranscript(transcript: Transcript, options: AnalyzeOptions = {}): TranscriptAnalysis {
  const minIdle = options.minIdle ?? 1;
  const events = sorted(transcript.events);
  const buckets = new Map<Bucket, number>();
  const calls = new Map<string, CallState>();
  const tools = new Map<string, RunState>();
  const outstanding = new Map<string, RunState>();
  const background = new Map<string, RunState>(); // async tool calls whose task has not ended
  const turns: TurnState[] = [];
  const timeline: TimelineItem[] = [];
  const segments: [number, number, Bucket][] = [];
  const models = new Set<string>();

  const add = (map: Map<Bucket, number>, bucket: Bucket, ms: number): void => {
    map.set(bucket, (map.get(bucket) ?? 0) + ms);
  };
  const charge = (bucket: Bucket, from: number, to: number): void => {
    add(buckets, bucket, to - from);
    const last = segments.at(-1);
    if (last?.[2] === bucket && last[1] === from) last[1] = to;
    else segments.push([from, to, bucket]);
  };
  const lastIndexOfMessage = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.kind === 'response') lastIndexOfMessage.set(e.messageId, i);
  });

  let state: State = 'start';
  let turn: TurnState | undefined;
  let prevTs: number | undefined;
  const firstOutstanding = (): RunState | undefined => outstanding.values().next().value;
  const idleBucket = (e: TraceEvent | undefined): IdleBucket =>
    e?.kind === 'notification' ? WAITING_ON_TASK : background.size ? WAITING_WITH_TASKS : WAITING;
  const startTurn = (ts: number, kind: TurnKind, text: string): void => {
    turn = { n: turns.length + 1, ts, kind, text, buckets: new Map(), calls: 0, out: 0, tools: 0, end: ts };
    turns.push(turn);
    timeline.push({ kind: 'turn', turn });
  };
  const stopTasks = (desc: ToolDescription): void => {
    const stops = desc.stops ?? [];
    for (const [id, task] of background) if (task.backgroundIds.some((x) => stops.includes(x))) background.delete(id);
  };

  events.forEach((e, i) => {
    if (e.kind === 'background_done') {
      // Out of band: it only changes which kind of idle the rest of an idle gap is.
      if (state === 'idle' && prevTs != null && e.ts > prevTs) {
        const next = events.slice(i + 1).find((x) => x.kind !== 'background_done');
        charge(idleBucket(next), prevTs, e.ts);
        prevTs = e.ts;
      }
      const launched = tools.get(e.toolCallId);
      if (launched) launched.bgEnd ??= e.ts;
      background.delete(e.toolCallId);
      return;
    }
    const gap = prevTs == null ? 0 : Math.max(0, e.ts - prevTs);
    prevTs = e.ts;

    // What was pending during the gap that this event ends?
    let bucket: Bucket | null;
    if (state === 'start') bucket = null;
    else if (state === 'compaction') bucket = 'compaction';
    else if (e.kind === 'response') bucket = 'model';
    else if (e.kind === 'tool_result') bucket = bucketOf(outstanding.get(e.toolCallId) ?? firstOutstanding());
    else if (e.kind === 'compaction_done') bucket = 'compaction';
    else if (state === 'idle') bucket = idleBucket(e);
    else if (state === 'tools') bucket = bucketOf(firstOutstanding());
    else bucket = 'model';

    if (bucket !== null && gap > 0) {
      charge(bucket, e.ts - gap, e.ts);
      if (isIdle(bucket)) {
        if (gap >= minIdle * 1000) timeline.push({ kind: 'idle', ts: e.ts, gap, bucket });
      } else if (turn) add(turn.buckets, bucket, gap);
    }

    switch (e.kind) {
      case 'response': {
        let call = calls.get(e.messageId);
        if (!call) {
          call = {
            messageId: e.messageId,
            ts: e.ts,
            start: bucket === 'model' ? e.ts - gap : e.ts,
            end: e.ts,
            ms: 0,
            ...(e.model !== undefined && { model: e.model }),
            synthetic: e.synthetic,
            stop: e.stop,
            blocks: [],
            text: '',
            tools: [],
            ...(turn && { turn }),
          };
          calls.set(e.messageId, call);
          if (turn) turn.calls++;
        }
        if (bucket === 'model') call.ms += gap;
        call.end = e.ts;
        if (e.usage) call.usage = e.usage;
        call.stop = e.stop;
        call.blocks.push(...e.blocks);
        if (e.text) call.text += (call.text ? ' ' : '') + e.text;
        for (const t of e.toolCalls) {
          const run: RunState = {
            id: t.id,
            name: t.name,
            input: t.input,
            desc: t.desc,
            start: e.ts,
            isError: false,
            interrupted: false,
            async: false,
            output: '',
            launches: {},
            backgroundIds: [],
            ...(turn && { turn }),
          };
          tools.set(t.id, run);
          outstanding.set(t.id, run);
          call.tools.push(run);
          if (turn) turn.tools++;
        }
        if (e.model && !e.synthetic) models.add(e.model);
        state = outstanding.size ? 'tools' : e.stop === 'end_turn' || e.stop === 'stop_sequence' ? 'idle' : 'model';
        if (lastIndexOfMessage.get(e.messageId) === i) {
          if (turn) turn.out += call.usage?.output ?? 0;
          timeline.push({ kind: 'call', call });
          if (state === 'model' && e.stop !== 'tool_use') state = 'idle';
        }
        break;
      }
      case 'tool_result': {
        const run = tools.get(e.toolCallId);
        if (run) {
          run.end = e.ts;
          run.ms = e.ts - run.start;
          // As the prototype does, a result after an interrupted one counts as an error.
          run.isError = e.isError || run.interrupted;
          run.interrupted = e.interrupted;
          run.output = e.output;
          run.async = e.async;
          run.launches = e.launches;
          run.backgroundIds = e.backgroundIds;
          if (run.async) background.set(run.id, run);
          if (run.desc.category === 'task-control') stopTasks(run.desc);
          timeline.push({ kind: 'tool', tool: run });
        }
        outstanding.delete(e.toolCallId);
        state = outstanding.size ? 'tools' : 'model';
        break;
      }
      case 'prompt':
        startTurn(e.ts, 'you', e.text);
        state = outstanding.size ? 'tools' : 'model';
        break;
      case 'notification':
        if (e.toolCallId !== undefined) {
          const launched = tools.get(e.toolCallId);
          if (launched) launched.bgEnd ??= e.ts;
          background.delete(e.toolCallId);
        }
        startTurn(e.ts, 'task', e.text);
        state = outstanding.size ? 'tools' : 'model';
        break;
      case 'command':
        startTurn(e.ts, 'command', e.name);
        state = e.compaction ? 'compaction' : 'idle';
        break;
      case 'compaction_done':
        state = 'idle';
        break;
      case 'interrupt':
        outstanding.clear();
        timeline.push({ kind: 'interrupt', ts: e.ts });
        state = 'idle';
        break;
    }
    if (turn && e.kind !== 'prompt' && e.kind !== 'notification' && e.kind !== 'command') turn.end = e.ts;
  });

  return {
    transcript,
    events,
    buckets,
    segments,
    calls: [...calls.values()],
    tools: [...tools.values()],
    turns,
    timeline,
    start: events[0]?.ts,
    end: events.at(-1)?.ts,
    models: [...models],
  };
}
