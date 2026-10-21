import type { ConversationEntry, RequestShape } from './conversation.js';
import type { TraceEvent } from './events.js';

/**
 * One compaction of the context, as the agent recorded it. A field is absent when the record
 * omits it.
 */
export interface Compaction {
  /** Context tokens before the compaction. */
  readonly preTokens?: number;
  /** Context tokens after it. */
  readonly postTokens?: number;
  readonly durationMs?: number;
  /** What started it, such as `manual` or `auto`. */
  readonly trigger?: string;
}

/** One transcript file: a session's own, or one of its subagents'. */
export interface Transcript {
  /** The transcript's id: its file name without the extension. */
  readonly id: string;
  /** The file it was read from. */
  readonly path: string;
  /** The title the agent gave the session, if any (the last one wins). */
  readonly title?: string;
  /** The working directory of the first record that names one. Previews are relative to it. */
  readonly cwd?: string;
  /** The events in file order; the analysis sorts them by time. */
  readonly events: readonly TraceEvent[];
  /** The compactions, in file order. */
  readonly compactions: readonly Compaction[];
  /**
   * What the transcript says, in file order, when `LoadOptions.conversation` asked for it and the
   * adapter reads it; absent otherwise.
   */
  readonly conversation?: readonly ConversationEntry[];
  /**
   * The system prompts and tools its model calls were sent with, in file order, when
   * `LoadOptions.conversation` asked for the conversation and the agent recorded them; absent otherwise.
   */
  readonly requestShapes?: readonly RequestShape[];
}

/** A subagent's transcript, as part of the session that started it. */
export interface AgentTranscript {
  /**
   * The agent's id. A tool result whose `launches.agentId` equals it is the call that started the
   * agent, which makes that call's transcript the agent's parent.
   */
  readonly id: string;
  readonly transcript: Transcript;
  /** What the agent was asked to do, in a few words. */
  readonly description?: string;
  /** The phase of its group the agent ran in, such as a workflow's phase. */
  readonly phase?: string;
  /** The kind of agent it was, such as a named subagent type. */
  readonly agentType?: string;
  /** True when the agent was started in the background. */
  readonly background: boolean;
  /** The {@link Group.id} of the group the agent ran in; `null` for an agent on its own. */
  readonly group: string | null;
}

/**
 * A group of agents that ran together, such as a workflow run. Its fields other than `id`, `kind`,
 * and `label` come from the group's own summary, when the agent wrote one.
 */
export interface Group {
  /** The group's id, such as a workflow run id; `launches.groupId` of a tool result refers to it. */
  readonly id: string;
  /**
   * What the agent calls a group like this one, such as `Workflow`. The report heads the group's
   * agents with it, its name, and its id: `Workflow build-feature wf_1a2b`.
   */
  readonly kind: string;
  /** How the viewer names the group, such as `Workflow build-feature`. */
  readonly label: string;
  /** The group's own name, such as the workflow's name. */
  readonly name?: string;
  /** How the group ended, such as `completed` or `failed`. */
  readonly status?: string;
  readonly durationMs?: number;
  readonly totalTokens?: number;
  readonly totalToolCalls?: number;
}

/**
 * A session: its main transcript, and the subagent transcripts and groups of agents it started.
 * Loading a subagent's transcript directly yields a session whose main transcript is that one and
 * that has no agents and no groups.
 */
export interface Session {
  /** The id of the adapter that loaded it. */
  readonly adapter: string;
  readonly main: Transcript;
  /** The subagents' transcripts, in the adapter's discovery order. */
  readonly agents: readonly AgentTranscript[];
  /** The groups the agents ran in, in the order their first agent was discovered. */
  readonly groups: readonly Group[];
  /**
   * The name the agent gives its shell tool, which titles the shell breakdown (`<name> by
   * command`); absent when the agent has no shell tool.
   */
  readonly shellToolName?: string;
}

/** A session as a listing shows it, without reading it as a timeline. */
export interface SessionSummary {
  /**
   * The session's id, which `Adapter.resolve` accepts, as a prefix too. The server opens a session
   * at `/s/<id>` only for an id of ASCII letters, digits, `_`, and `-`, so that a URL never holds a
   * path; it lists a session with any other id without a link.
   */
  readonly id: string;
  readonly path: string;
  /** The first and last record times, epoch milliseconds. */
  readonly start: number;
  readonly end: number;
  /** The title the agent gave the session, if any. */
  readonly title?: string;
  /** The text of the person's first prompt, if any. */
  readonly firstPrompt?: string;
  /** The transcript's size in bytes. */
  readonly size: number;
}
