import type { Bucket, TurnKind } from '../analysis/types.js';
import type { Conversation } from '../conversation/types.js';
import type { ToolCategory } from '../model/index.js';

// The client reads these through this module only.
export type { Bucket, ToolCategory, TurnKind };
export type * from '../conversation/types.js';

// The JSON the viewer reads, embedded in its page by renderHtml. The builder (build.ts) writes it
// and the browser client (src/viewer/client/) reads it, so both share these types.
//
// The fields and values are the prototype's, so that its view data and this one compare equal;
// the only additions are ViewData.toolCategories, ViewData.shellLabel, ToolSpan.cat, and
// ViewGroup.kind, which let the client color, filter, and name things by category instead of by an
// agent's tool names, and the links to the conversation page (ViewData.conversationHref,
// IndexSession.conversationHref, and each span's id), which the prototype has not. Numbers the prototype computes as NaN (the wall time of a transcript
// without events) are null, as JSON writes NaN.

/** What a page of the viewer shows: one session's timeline, its conversation, or the index of a store's sessions. */
export type PageData = ViewData | IndexData | ConversationData;

/** One session: a lane per transcript, in groups. */
export interface ViewData {
  readonly session: ViewSession;
  /** The groups of lanes, in display order: the session first, then by their first start. */
  readonly groups: readonly ViewGroup[];
  /** The main transcript's lane first, then the agents' lanes by start. */
  readonly lanes: readonly ViewLane[];
  /** When the data was built, epoch milliseconds. */
  readonly generated: number;
  /** True when the server serves the page, which then links back to the index. */
  readonly serve?: true;
  /** The category of every tool the lanes name, by the tool's name. */
  readonly toolCategories: Readonly<Record<string, ToolCategory>>;
  /** The name of the agent's shell tool, for the legend, the trace filter, and the breakdown; `Shell` when it has none. */
  readonly shellLabel: string;
  /** Where the session's conversation page is, when the server serves it. */
  readonly conversationHref?: string;
}

export interface ViewSession {
  /** The main transcript's id. */
  readonly id: string;
  readonly title: string | null;
  readonly cwd: string | null;
  /** The main transcript's path, as it was resolved. */
  readonly file: string;
}

/**
 * A group of lanes: `main`, the session's own lane; `agents`, the agents that ran on their own;
 * and one per group of agents the session ran (such as a workflow run), which has a `kind`.
 */
export interface ViewGroup {
  readonly id: string;
  readonly label: string;
  /** The first start of its lanes; absent for `main`, null when a lane has no events. */
  readonly start?: number | null;
  /** A group of agents' summary, null where it has none. */
  readonly status?: string | null;
  readonly ms?: number | null;
  readonly tokens?: number | null;
  readonly toolCalls?: number | null;
  /** What the agent calls such a group, such as `Workflow`; only on a group of the session's agents. */
  readonly kind?: string;
}

/** One transcript: its state track, its model and tool spans, and its turns. */
export interface ViewLane {
  /** `main`, or the agent's id. */
  readonly id: string;
  readonly label: string;
  /** The id of its {@link ViewGroup}. */
  readonly group: string;
  /** The lane whose tool call launched it: `main`, an agent's id, or null. */
  readonly parent: string | null;
  /** An agent's lane only: its phase in its group, its type, and how it was started. */
  readonly phase?: string | null;
  readonly agentType?: string | null;
  readonly background?: boolean;
  /** An agent's lane only: its parent is another agent. */
  readonly nested?: boolean;
  /** Its first and last events' times; absent for a transcript without events. */
  readonly start?: number;
  readonly end?: number;
  readonly title: string | null;
  /** What was pending, end to end. */
  readonly seg: readonly ViewSegment[];
  /** Tool and model spans, by start (a model span before a tool span that starts with it). */
  readonly spans: readonly ViewSpan[];
  readonly turns: readonly ViewTurn[];
  /** Wall time by bucket, largest first. */
  readonly buckets: readonly (readonly [Bucket, number])[];
  /** The shell breakdown: `[command key, ms, calls, longest, failed]`, largest first. */
  readonly bash: readonly ShellTuple[];
  readonly stats: ViewStats;
}

export type ViewSegment = readonly [start: number, end: number, bucket: Bucket];

export type ShellTuple = readonly [key: string, ms: number, calls: number, max: number, failed: number];

export type ViewSpan = ToolSpan | ModelSpan;

/** A tool call, from the response that asked for it to its result. */
export interface ToolSpan {
  readonly t: 't';
  readonly s: number;
  /** Its result's time; its start when it has none. */
  readonly e: number;
  /** Null without a result. */
  readonly ms: number | null;
  readonly name: string;
  /** The one-line preview. */
  readonly pv: string;
  /** The agent's own note on the call, or empty. */
  readonly desc: string;
  /** The input as a person reads it, clipped. */
  readonly in: string;
  /** The result, clipped. */
  readonly out: string;
  readonly err: boolean;
  readonly intr: boolean;
  readonly async: boolean;
  /** When its background task reported back. */
  readonly bgEnd: number | null;
  /** The agent it launched (a lane's id), and the group of agents it started (a group's id). */
  readonly agent: string | null;
  readonly run: string | null;
  /** The number of the turn it was asked for in. */
  readonly turn: number | null;
  readonly cat: ToolCategory;
  /** The tool call's id, which links to it in the conversation page. */
  readonly id: string;
}

/** A model call, from its start to its last record. */
export interface ModelSpan {
  readonly t: 'm';
  readonly s: number;
  readonly e: number;
  readonly ms: number;
  /** Absent when its first record names no model. */
  readonly model?: string;
  readonly syn: boolean;
  /** Token counts; null when the transcript's usage is not known. */
  readonly out: number | null;
  readonly cr: number | null;
  readonly cw: number | null;
  readonly stop: string | null;
  readonly think: boolean;
  /** Its text, clipped. */
  readonly text: string;
  /** The indexes, in the lane's spans, of the tool calls it asked for. */
  readonly tools: readonly number[];
  /** One line that says what it did. */
  readonly sum: string;
  readonly turn: number | null;
  /** The message's id, which links to it in the conversation page. */
  readonly id: string;
}

export interface ViewTurn {
  readonly n: number;
  readonly ts: number;
  readonly end: number;
  readonly kind: TurnKind;
  /** Its prompt, notification, or command, clipped. */
  readonly text: string;
  readonly calls: number;
  readonly tools: number;
  /** Its active time by bucket, in the order charged. */
  readonly b: readonly (readonly [Bucket, number])[];
}

export interface ViewStats {
  /** Null for a transcript without events. */
  readonly wall: number | null;
  readonly active: number;
  readonly model: number;
  readonly tools: number;
  /** The person's time: waiting on them and answering questions. */
  readonly you: number;
  readonly calls: number;
  readonly toolCalls: number;
  /** Token totals; null when the transcript's usage is not known. */
  readonly out: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly models: readonly string[];
  readonly compactions: readonly ViewCompaction[];
}

/** A compaction; a field is absent when the transcript left it out. */
export interface ViewCompaction {
  readonly pre?: number;
  readonly post?: number;
  readonly ms?: number;
  readonly trigger?: string;
}

/** The index page of a store's sessions. */
export interface IndexData {
  readonly index: {
    /** The store. */
    readonly projectDir: string;
    /** Who wrote the sessions, the adapter's display name, as in `Claude Code sessions`. */
    readonly agent: string;
    readonly sessions: readonly IndexSession[];
  };
}

export interface IndexSession {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly size: number;
  readonly title: string | null;
  /** The first prompt on one line, at most 200 characters; empty when there is none. */
  readonly first: string;
  /** Where the server serves the session's viewer; null for an id it cannot put in a URL. */
  readonly href: string | null;
  /** Where the server serves the session's conversation; null for an id it cannot put in a URL. */
  readonly conversationHref: string | null;
}

/** The conversation page of one session: what its transcripts say, turn by turn. */
export interface ConversationData {
  /** Its texts clipped to their head and tail (view/conversation.ts's `CONVERSATION_TEXT`). */
  readonly conversation: Conversation;
  /** When the data was built, epoch milliseconds. */
  readonly generated: number;
  /** True when the server serves the page, which then links back to the index. */
  readonly serve?: true;
  /** Where the session's timeline is, when the server serves it. */
  readonly timelineHref?: string;
}
