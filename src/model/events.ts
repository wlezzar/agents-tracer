import type { ToolCall } from './tools.js';

/**
 * The events a transcript holds, in an agent-neutral form. An adapter maps an agent's records to
 * them; the analysis walks them in time order and charges each gap between consecutive events to
 * what was pending (see docs/model.md).
 *
 * Every event has `ts`, epoch milliseconds. A transcript keeps its events in file order; records
 * are not always written in time order (a compaction's summary lands late), so the analysis sorts
 * them by `ts`, keeping file order between equal times.
 */
export type TraceEvent =
  | PromptEvent
  | NotificationEvent
  | CommandEvent
  | ResponseEvent
  | ToolResultEvent
  | BackgroundDoneEvent
  | CompactionDoneEvent
  | InterruptEvent;

/** The `kind` of each {@link TraceEvent}. */
export type TraceEventKind = TraceEvent['kind'];

/**
 * A prompt, which starts a turn by `you`. Usually the person's; a prompt from another origin (a
 * scheduled wake-up, a hook) carries it as `[origin] text`.
 */
export interface PromptEvent {
  readonly kind: 'prompt';
  readonly ts: number;
  readonly text: string;
}

/**
 * A background task reporting back as a new turn of its own (a `task` turn). It ends that task, as
 * {@link BackgroundDoneEvent} does.
 */
export interface NotificationEvent {
  readonly kind: 'notification';
  readonly ts: number;
  /** What the task reported, shown as the turn's text. */
  readonly text: string;
  /** The tool call that launched the task, when the notification names it. */
  readonly toolCallId?: string;
}

/**
 * A local slash command the person ran, which starts a `command` turn. The session is idle after
 * it, unless it is a compaction, which keeps the session in the compaction state until
 * {@link CompactionDoneEvent}.
 */
export interface CommandEvent {
  readonly kind: 'command';
  readonly ts: number;
  /** The command as typed, such as `/clear`; shown as the turn's text. */
  readonly name: string;
  readonly compaction: boolean;
}

/** Token counts of one model call. Missing counts are 0. */
export interface Usage {
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Input tokens that were neither read from nor written to the cache. */
  readonly input: number;
}

/**
 * Why a model response ended, in the Anthropic Messages API's vocabulary, which is the analysis's:
 * `end_turn` and `stop_sequence` end the turn (the session goes idle), and `tool_use` keeps the
 * model pending until it asks for its tools; any other reason, such as `max_tokens`, or none ends
 * the turn at the message's last record (docs/model.md). An adapter for another API maps its
 * reasons onto these. (`string & {}` admits any other reason while keeping these in editors'
 * completions.)
 */
export type StopReason = 'end_turn' | 'stop_sequence' | 'tool_use' | 'max_tokens' | (string & {});

/**
 * One record of a model response. An agent may write one response over several records (one per
 * content block); the records that share `messageId` form one model call.
 */
export interface ResponseEvent {
  readonly kind: 'response';
  readonly ts: number;
  readonly messageId: string;
  /** The model's id; absent when the record does not name one. */
  readonly model?: string;
  /**
   * True for a response the agent wrote itself rather than the model (an API error, a canned
   * reply). Synthetic calls are left out of the slowest-responses table and of the models used.
   */
  readonly synthetic: boolean;
  /**
   * Why the model stopped ({@link StopReason}). `null` when the record has none, as in transcripts
   * written mid-stream: when more than a tenth of a transcript's model calls have none, its token
   * counts are taken as not recorded (`usageKnown` in the analysis), and the report and the viewer
   * leave them out.
   */
  readonly stop: StopReason | null;
  /** The usage the record reports. A call keeps the last usage its records report. */
  readonly usage?: Usage;
  /**
   * The types of the record's content blocks, in order, in the Anthropic Messages API's vocabulary:
   * `thinking` and `redacted_thinking` mark reasoning; `text` and `tool_use` are the others seen.
   */
  readonly blocks: readonly string[];
  /** The record's text blocks joined by a space; empty when it has none. */
  readonly text: string;
  /** The tool calls the record asks for, in order. */
  readonly toolCalls: readonly ToolCall[];
}

/** The result of a tool call. */
export interface ToolResultEvent {
  readonly kind: 'tool_result';
  readonly ts: number;
  readonly toolCallId: string;
  /** The tool reported an error. This alone makes a call `failed` in the report. */
  readonly isError: boolean;
  /** The person interrupted the call. */
  readonly interrupted: boolean;
  /** The result as text; non-text parts appear as `[type]`. */
  readonly output: string;
  /**
   * The call returned while its work goes on in the background (a background shell, a background
   * subagent). The session then has a background task until a {@link BackgroundDoneEvent} or a
   * {@link NotificationEvent} for the call, or a task-control call that stops it.
   */
  readonly async: boolean;
  /** Every id the agent may later use for the background task (task ids, agent ids). */
  readonly backgroundIds: readonly string[];
  /**
   * What the call started: `agentId` links to the subagent transcript it launched
   * (`AgentTranscript.id`), `groupId` to the group of agents it started (`Group.id`).
   */
  readonly launches: { readonly agentId?: string; readonly groupId?: string };
}

/**
 * An out-of-band signal that the background task a tool call started has finished. It may land
 * mid-turn; it only changes which kind of idle the rest of an idle gap is, and ends the task.
 */
export interface BackgroundDoneEvent {
  readonly kind: 'background_done';
  readonly ts: number;
  readonly toolCallId: string;
}

/** The compacted summary landed, which ends the compaction state. */
export interface CompactionDoneEvent {
  readonly kind: 'compaction_done';
  readonly ts: number;
}

/** The person interrupted the turn: every outstanding tool call is dropped and the session goes idle. */
export interface InterruptEvent {
  readonly kind: 'interrupt';
  readonly ts: number;
}
