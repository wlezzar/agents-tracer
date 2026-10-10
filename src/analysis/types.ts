import type {
  AgentTranscript,
  Session,
  StopReason,
  ToolCategory,
  ToolDescription,
  TraceEvent,
  Transcript,
  Usage,
} from '../model/index.js';

// What the analysis of a transcript produces. docs/model.md describes the timing semantics.

/** The idle buckets: time the agent waited, not worked. Their names are output. */
export type IdleBucket =
  'idle: waiting on you' | 'idle: waiting on you, background tasks running' | 'idle: waiting on a background task';

/**
 * What was pending during a stretch of wall time. The names are output, kept exactly: the model
 * generating, a compaction, a tool by its name (`tool:?` when a result arrives for no call that
 * is outstanding), the person answering the agent's question, or one of the idle buckets.
 */
export type Bucket = 'model' | 'compaction' | 'you: answering questions' | `tool:${string}` | IdleBucket;

/** A stretch of wall time, `[start, end)` in epoch milliseconds, and what was pending during it. */
export type Segment = readonly [start: number, end: number, bucket: Bucket];

/** Who started a turn: the person (`you`), a background task reporting back, or a slash command. */
export type TurnKind = 'you' | 'task' | 'command';

/** A turn: from a prompt, a task's notification, or a command, to the next one. */
export interface Turn {
  /** 1 for the first turn. */
  readonly n: number;
  /** When it started: the time of the event that started it. */
  readonly ts: number;
  readonly kind: TurnKind;
  /** The prompt, the notification's text, or the command's name. */
  readonly text: string;
  /** The turn's active time by bucket (idle buckets are never charged to a turn). */
  readonly buckets: ReadonlyMap<Bucket, number>;
  /** The model calls that began in it. */
  readonly calls: number;
  /** The tool calls asked for in it. */
  readonly tools: number;
  /** The output tokens of the calls that ended in it, each counted at its last record. */
  readonly out: number;
  /**
   * The time of its last response, tool result, compaction end, or interrupt; its start when it
   * has none.
   */
  readonly end: number;
}

/** A tool call as it ran: the request, when it was asked for, and its result. */
export interface ToolRun {
  readonly id: string;
  /** The agent's name for the tool. */
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly desc: ToolDescription;
  /** When it was asked for: the time of the response record that carried it. */
  readonly start: number;
  /** When its (last) result arrived; absent without a result. */
  readonly end?: number;
  /** `end - start`; absent without a result. */
  readonly ms?: number;
  /**
   * Its last result reported an error, or its result before that was interrupted. This alone is
   * `failed` in the report.
   */
  readonly isError: boolean;
  /** Its last result says the person interrupted it. */
  readonly interrupted: boolean;
  /** Its last result returned while its work goes on in the background. */
  readonly async: boolean;
  /** When its background task finished: the first background-done signal or notification for it. */
  readonly bgEnd?: number;
  /** Its last result's text; empty without a result. */
  readonly output: string;
  /** What its last result started: a subagent (`agentId`) or a group of agents (`groupId`). */
  readonly launches: { readonly agentId?: string; readonly groupId?: string };
  /** The ids its last result gave its background task. */
  readonly backgroundIds: readonly string[];
  /** The turn it was asked for in; absent before the first turn. */
  readonly turn?: Turn;
}

/** A model call: the records of one message, which share an id. */
export interface ModelCall {
  readonly messageId: string;
  /** The time of its first record (the report's clock column). */
  readonly ts: number;
  /**
   * When it started: the previous event's time when its first record ended a gap of model time,
   * else its first record's time.
   */
  readonly start: number;
  /** The time of its last record. */
  readonly end: number;
  /** The model time charged to its records. */
  readonly ms: number;
  /** The model its first record names. */
  readonly model?: string;
  /** Its first record was written by the agent, not the model (see `ResponseEvent.synthetic`). */
  readonly synthetic: boolean;
  /** The usage of its last record that reported one. */
  readonly usage?: Usage;
  /** Its last record's stop reason. */
  readonly stop: StopReason | null;
  /** Every record's content block types, in order. */
  readonly blocks: readonly string[];
  /** Its records' texts joined by a space. */
  readonly text: string;
  /** The tool calls its records asked for. */
  readonly tools: readonly ToolRun[];
  /** The turn it began in; absent before the first turn. */
  readonly turn?: Turn;
}

/**
 * An entry of the timeline, in walk order: a turn as it starts, a model call at its last record, a
 * tool call at its result, an idle gap of at least the minimum idle at the event that ends it, an
 * interrupt. Entries refer to the analysis's turns, calls, and tool calls, whose fields are final.
 */
export type TimelineItem =
  | { readonly kind: 'turn'; readonly turn: Turn }
  | { readonly kind: 'call'; readonly call: ModelCall }
  | { readonly kind: 'tool'; readonly tool: ToolRun }
  | { readonly kind: 'idle'; readonly ts: number; readonly gap: number; readonly bucket: IdleBucket }
  | { readonly kind: 'interrupt'; readonly ts: number };

/** How to analyze. */
export interface AnalyzeOptions {
  /** The shortest idle gap, in seconds, that is a timeline item; 1 by default. */
  readonly minIdle?: number;
}

/** The analysis of one transcript. */
export interface TranscriptAnalysis {
  readonly transcript: Transcript;
  /** The events in time order, file order between equal times. */
  readonly events: readonly TraceEvent[];
  /** Wall time by bucket, in the order buckets were first charged. */
  readonly buckets: ReadonlyMap<Bucket, number>;
  /** What was pending, end to end: contiguous, adjacent equal buckets merged. */
  readonly segments: readonly Segment[];
  /** One per message, in the order of their first records. */
  readonly calls: readonly ModelCall[];
  /** One per tool call id, in the order they were first asked for. */
  readonly tools: readonly ToolRun[];
  readonly turns: readonly Turn[];
  readonly timeline: readonly TimelineItem[];
  /** The first and last events' times; `undefined` for a transcript without events. */
  readonly start: number | undefined;
  readonly end: number | undefined;
  /** The models of the non-synthetic calls, in order of first use. */
  readonly models: readonly string[];
}

/** The id `AgentAnalysis.parent` gives the session's main transcript. */
export const MAIN = 'main';

/** A subagent's transcript analyzed, with where it sits in the session. */
export interface AgentAnalysis {
  readonly agent: AgentTranscript;
  readonly analysis: TranscriptAnalysis;
  /**
   * The transcript that launched it: {@link MAIN} or another agent's id, from the tool result
   * whose `launches.agentId` is its id (the last, when several are; a later agent's wins over the
   * main transcript's). An agent in a group that no tool result launched has the main transcript
   * as its parent; any other such agent has none (`null`).
   */
  readonly parent: string | null;
  /** Its parent is another agent. */
  readonly nested: boolean;
  /** The main transcript's tool call that launched it (the last, when several did). */
  readonly launcher?: ToolRun;
}

/** A session analyzed: its main transcript and its agents', in the session's order. */
export interface SessionAnalysis {
  readonly session: Session;
  readonly main: TranscriptAnalysis;
  readonly agents: readonly AgentAnalysis[];
}

/** A row of the shell breakdown: the calls of one shell command key. */
export interface ShellRow {
  /** `shellKey` of the command, with ` [bg]` for one run in the background. */
  readonly key: string;
  /** The sum of the calls' durations. */
  readonly ms: number;
  readonly calls: number;
  /** The longest call. */
  readonly max: number;
  /** The calls that failed (`isError`). */
  readonly failed: number;
}

/** A tool's name and category, all `bucketOf` reads. */
export interface ToolLike {
  readonly name: string;
  readonly desc: { readonly category: ToolCategory };
}
