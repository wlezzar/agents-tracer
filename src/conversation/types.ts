import type { Segment, TurnKind } from '../analysis/types.js';
import type { ContextSource, Permission, ToolCategory } from '../model/index.js';

// A session's conversation as the conversation page and the Markdown export read it: a thread per
// transcript, its turns, and in each turn what was said, in order, with the tools' results beside
// the calls that asked for them and the timing from the analysis. Plain data, so that the view
// embeds it as JSON as it is.

export type { ContextSource, Permission, Segment, ToolCategory, TurnKind };

/** A session's conversation: the main transcript's thread first, then the agents' by start. */
export interface Conversation {
  readonly session: {
    /** The main transcript's id. */
    readonly id: string;
    readonly title: string | null;
    readonly cwd: string | null;
    /** The main transcript's path, as it was resolved. */
    readonly file: string;
  };
  /** The name of the agent's shell tool; `Shell` when it has none. */
  readonly shellLabel: string;
  readonly threads: readonly Thread[];
  /** The groups of agents the session ran, such as workflow runs, by their first agent's start. */
  readonly groups: readonly ThreadGroup[];
  /** The system prompts and tools the threads' model calls were sent with, each once, when the agent recorded them. */
  readonly shapes: readonly Shape[];
}

/** A group of agents that ran together, such as a workflow run; a field is null where its summary has none. */
export interface ThreadGroup {
  readonly id: string;
  /** How to name it, such as `Workflow build-feature`, and what the agent calls such a group, such as `Workflow`. */
  readonly label: string;
  readonly kind: string;
  readonly status: string | null;
  readonly ms: number | null;
  readonly tokens: number | null;
  readonly toolCalls: number | null;
  /** The thread whose tool call started it, and that call's id; null when no call did. */
  readonly parent: string | null;
  readonly launcher: string | null;
}

/** A system prompt and tools that model calls were sent with, with their sizes estimated (`estimateTokens`). */
export interface Shape {
  readonly id: string;
  readonly system: readonly SystemBlock[];
  readonly tools: readonly ToolDef[];
  /** The system prompt's estimated tokens, and the tools' that are not deferred. */
  readonly systemTokens: number;
  readonly toolTokens: number;
}

/** A block of a system prompt. */
export interface SystemBlock {
  readonly text: string;
  readonly tokens: number;
}

/** A tool as the model was told of it. */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** Its input schema, as pretty-printed JSON. */
  readonly schema: string;
  /** Loaded only when the model looks for it, so that it does not fill the context until then. */
  readonly deferred: boolean;
  /** Its definition's estimated tokens: its name, description, and schema. */
  readonly tokens: number;
}

/** A shape a thread's model calls were sent with: how many, and the first of them. */
export interface ThreadShape {
  readonly id: string;
  readonly calls: number;
  /** The first call's message id and time. */
  readonly first: string;
  readonly ts: number;
}

/** One transcript's conversation. */
export interface Thread {
  /** `main`, or the agent's id: the id of its lane in the timeline. */
  readonly id: string;
  readonly label: string;
  /** The thread whose tool call launched it, and that call's id; null for the main thread and an agent nothing launched. */
  readonly parent: string | null;
  readonly launcher: string | null;
  readonly agentType: string | null;
  readonly phase: string | null;
  readonly background: boolean;
  /** The id of the {@link ThreadGroup} it ran in; null for the main thread and an agent on its own. */
  readonly group: string | null;
  /** Its first and last events' times; null for a transcript without events. */
  readonly start: number | null;
  readonly end: number | null;
  /** What was pending, end to end: the analysis's segments, as the timeline's state track has them. */
  readonly segments: readonly Segment[];
  /** Whether its token counts were recorded (the analysis's `usageKnown`); its output tokens are null otherwise. */
  readonly usageKnown: boolean;
  readonly stats: ThreadStats;
  /** The shapes its model calls were sent with, in the order it first used them; empty when not recorded. */
  readonly shapes: readonly ThreadShape[];
  /** What looks worth improving in it, most severe first (`findings`). */
  readonly findings: readonly Finding[];
  /** Its turns; a turn numbered 0 first when anything came before the first prompt. */
  readonly turns: readonly ConversationTurn[];
}

export interface ThreadStats {
  /** Null for a transcript without events. */
  readonly wall: number | null;
  readonly active: number;
  readonly model: number;
  readonly tools: number;
  /** The person's time: waiting on them and answering questions. */
  readonly you: number;
  readonly calls: number;
  readonly toolCalls: number;
  /** Tool calls that failed or were interrupted. */
  readonly failed: number;
  /** Tool calls the agent or the person refused to run. */
  readonly denied: number;
  /** Output tokens; null when not recorded. */
  readonly out: number | null;
  /** The most tokens of context a model call read; null without usage. */
  readonly peakContext: number | null;
  /** The harness's context items, and their estimated tokens. */
  readonly contextItems: number;
  readonly contextTokens: number;
  readonly compactions: number;
}

/** A turn: what started it and everything until the next one. */
export interface ConversationTurn {
  /** Its number, as the timeline's; 0 for what came before the first prompt. */
  readonly n: number;
  /** Who started it; null for turn 0. */
  readonly kind: TurnKind | null;
  readonly ts: number;
  /** The time of its last item. */
  readonly end: number;
  /** Its active time, as the analysis charged it. */
  readonly active: number;
  readonly items: readonly ConversationItem[];
}

export type ConversationItem = PromptItem | ContextItem | ModelItem | CompactionItem | NoticeItem | ResultItem;

/** The prompt, report, or command that started the turn. */
export interface PromptItem {
  readonly type: 'prompt';
  readonly ts: number;
  readonly by: TurnKind;
  readonly text: string;
  readonly origin: string | null;
  /** A short line for a long text, such as a task report's summary. */
  readonly summary: string | null;
  readonly images: number;
}

/** Something the harness put in front of the model. */
export interface ContextItem {
  readonly type: 'context';
  readonly ts: number;
  readonly source: ContextSource;
  readonly label: string;
  readonly text: string;
  /** Its size, estimated (`estimateTokens`). */
  readonly tokens: number;
}

/** A model call: its records' blocks in order, with the tool calls' results. */
export interface ModelItem {
  readonly type: 'model';
  /** The message's id. */
  readonly id: string;
  /** Its first record's time. */
  readonly ts: number;
  /** When it started and ended, and the model time charged to it, from the analysis. */
  readonly start: number;
  readonly end: number;
  readonly ms: number;
  readonly model: string | null;
  readonly synthetic: boolean;
  /** The agent wrote it to report an error from the model's API. */
  readonly error: boolean;
  readonly stop: string | null;
  /** The tokens of context it read (input, cache reads, and cache writes); null without usage, and for a synthetic call. */
  readonly context: number | null;
  /** Its output tokens; null without usage, or when the thread's were not recorded. */
  readonly out: number | null;
  /** Of its context, the tokens read from the prompt cache and written to it; null as `context` is. */
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  /** What it was sent with besides the messages, when the agent recorded its request. */
  readonly request: ModelRequest | null;
  readonly blocks: readonly ConversationBlock[];
}

/** A model call's request: its shape, and the settings it was sent with, each null when not recorded. */
export interface ModelRequest {
  readonly shape: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly maxTokens: number | null;
  readonly thinking: string | null;
}

export type ConversationBlock =
  | { readonly type: 'thinking'; readonly text: string; readonly redacted: boolean; readonly ms: number | null }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'other'; readonly label: string; readonly text: string }
  | ToolBlock;

/** What became of a tool call: done, failed, interrupted, or without a result. */
export type ToolStatus = 'ok' | 'error' | 'interrupted' | 'pending';

/** A tool call with its result. */
export interface ToolBlock {
  readonly type: 'tool';
  readonly id: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly preview: string;
  /** The agent's own note on the call, or empty. */
  readonly purpose: string;
  /** The preview without the purpose it may start with, to show beside the purpose. */
  readonly detail: string;
  /** The input as a person reads it. */
  readonly input: string;
  readonly output: string;
  readonly status: ToolStatus;
  /** It returned while its work went on in the background. */
  readonly async: boolean;
  readonly start: number;
  /** Its result's time, and how long it took; null without a result. */
  readonly end: number | null;
  readonly ms: number | null;
  readonly images: number;
  /** The output's size, estimated (`estimateTokens`). */
  readonly tokens: number;
  readonly permission: Permission | null;
  /** The thread of the agent it launched, when the session holds it. */
  readonly agent: string | null;
  /** For a file tool, the file it read or wrote. */
  readonly file: { readonly path: string; readonly access: 'read' | 'write' } | null;
}

/** A compaction of the context. */
export interface CompactionItem {
  readonly type: 'compaction';
  readonly ts: number;
  readonly trigger: string | null;
  readonly preTokens: number | null;
  readonly postTokens: number | null;
  readonly summary: string;
}

/** An interrupt, a fallback to another model, a warning. */
export interface NoticeItem {
  readonly type: 'notice';
  readonly ts: number;
  readonly level: 'info' | 'warning' | 'error';
  readonly text: string;
  /** The person interrupted the agent. */
  readonly interrupt: boolean;
}

/** A result for no tool call the thread asked for. */
export interface ResultItem {
  readonly type: 'result';
  readonly ts: number;
  readonly id: string;
  readonly output: string;
  readonly status: ToolStatus;
}

/**
 * What a finding is about:
 *
 * - `retry`: a tool call that failed, made again unchanged.
 * - `api-error`: an error from the model's API, or one the agent reported.
 * - `failed-edit`: a file write or edit that failed.
 * - `denied`: tool calls the agent's rules, its mode, or the person refused.
 * - `interrupt`: the person interrupted the agent.
 * - `cache-miss`: a model call that wrote again to the prompt cache what the call before it had cached, without a pause between them.
 * - `cache-lapse`: the same, after a pause long enough for the cache to lapse.
 * - `shape-change`: the system prompt or the tools changed between two model calls.
 * - `repeated-read`: the same read of a file made again, the file unchanged in between.
 * - `large-output`: a tool output large enough to fill much of the context.
 * - `repeated-context`: the same harness text added again and again.
 * - `compaction`: the context filled up and was compacted.
 * - `context-jump`: the context grew by much in one step.
 * - `heavy-context`: one harness item large enough to cost much of the context.
 * - `unused-tools`: tools the model was told of and never called.
 * - `slow`: a tool call that took minutes.
 */
export type FindingKind =
  | 'retry'
  | 'api-error'
  | 'failed-edit'
  | 'denied'
  | 'interrupt'
  | 'cache-miss'
  | 'cache-lapse'
  | 'shape-change'
  | 'repeated-read'
  | 'large-output'
  | 'repeated-context'
  | 'compaction'
  | 'context-jump'
  | 'heavy-context'
  | 'unused-tools'
  | 'slow';

/** How much a finding likely costs: `high` first. */
export type Severity = 'high' | 'medium' | 'low';

/** Something in a thread that looks worth improving in the harness, and where it happened. */
export interface Finding {
  readonly kind: FindingKind;
  readonly severity: Severity;
  /** The thread it is in. */
  readonly thread: string;
  /** What happened, in one line. */
  readonly title: string;
  /** Why it matters, or what to look at. */
  readonly detail: string;
  /** The tokens it cost, estimated; null when it costs time or attention instead. */
  readonly tokens: number | null;
  /** Where it happened, in the thread's order; empty for a finding about the whole thread. */
  readonly at: readonly FindingRef[];
}

/** A place in a thread: an item of a turn, and a tool call of it when the item is a model call. */
export interface FindingRef {
  /** The turn's number, and the item's index in its items. */
  readonly turn: number;
  readonly item: number;
  readonly tool: string | null;
  /** What is there, in a few words. */
  readonly label: string;
}
