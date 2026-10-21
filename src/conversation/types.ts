import type { TurnKind } from '../analysis/types.js';
import type { ContextSource, Permission, ToolCategory } from '../model/index.js';

// A session's conversation as the conversation page and the Markdown export read it: a thread per
// transcript, its turns, and in each turn what was said, in order, with the tools' results beside
// the calls that asked for them and the timing from the analysis. Plain data, so that the view
// embeds it as JSON as it is.

export type { ContextSource, Permission, ToolCategory, TurnKind };

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
  /** Its first and last events' times; null for a transcript without events. */
  readonly start: number | null;
  readonly end: number | null;
  /** Whether its token counts were recorded (the analysis's `usageKnown`); its output tokens are null otherwise. */
  readonly usageKnown: boolean;
  readonly stats: ThreadStats;
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
  readonly blocks: readonly ConversationBlock[];
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
}

/** A result for no tool call the thread asked for. */
export interface ResultItem {
  readonly type: 'result';
  readonly ts: number;
  readonly id: string;
  readonly output: string;
  readonly status: ToolStatus;
}
