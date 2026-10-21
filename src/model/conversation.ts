import type { StopReason, Usage } from './events.js';
import type { ToolCall } from './tools.js';

/**
 * What a transcript says, as a person reads it: the prompts, the model's reasoning, text, and tool
 * calls, the tools' results, and everything the harness put in front of the model besides. An
 * adapter fills `Transcript.conversation` with these, in file order, when `LoadOptions.conversation`
 * asks for them. They are apart from the events, which the timing reads, so that nothing a
 * conversation holds changes where the time went.
 *
 * Every entry has `ts`, epoch milliseconds: the time of the record it comes from.
 */
export type ConversationEntry =
  PromptEntry | ResponseEntry | ResultEntry | ContextEntry | CompactionEntry | NoticeEntry;

/** The `kind` of each {@link ConversationEntry}. */
export type ConversationEntryKind = ConversationEntry['kind'];

/**
 * What starts a turn: the person's prompt (`you`), a background task reporting back (`task`), or a
 * slash command (`command`). An adapter makes one for each prompt, notification, and command
 * event, and for nothing else, in the same order, so that the conversation's turns are the
 * analysis's.
 */
export interface PromptEntry {
  readonly kind: 'prompt';
  readonly ts: number;
  readonly by: 'you' | 'task' | 'command';
  /** The prompt, the task's report, or the command as typed with its arguments. */
  readonly text: string;
  /** Where a prompt that is not the person's came from, such as a scheduled wake-up. */
  readonly origin?: string;
  /** A short line for a long text, such as a task report's summary. */
  readonly summary?: string;
  /** The images it holds, which the conversation counts but does not keep. */
  readonly images: number;
}

/**
 * One record of a model response, as a `ResponseEvent` is: the records that share `messageId` are
 * one model call, whose blocks are theirs in order.
 */
export interface ResponseEntry {
  readonly kind: 'response';
  readonly ts: number;
  readonly messageId: string;
  readonly model?: string;
  /** Written by the agent rather than the model, as `ResponseEvent.synthetic`. */
  readonly synthetic: boolean;
  /** The agent wrote it to report an error from the model's API. */
  readonly error: boolean;
  readonly stop: StopReason | null;
  readonly usage?: Usage;
  readonly blocks: readonly ResponseBlock[];
}

/** A content block of a response. */
export type ResponseBlock =
  | {
      /** The model's reasoning. Its text is empty when the agent did not record it (or it was redacted). */
      readonly type: 'thinking';
      readonly text: string;
      readonly redacted: boolean;
      /** How long the model reasoned, when the agent recorded it. */
      readonly ms?: number;
    }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly call: ToolCall }
  /** A block of another type, such as a tool the model's API ran itself: its type and its content as text. */
  | { readonly type: 'other'; readonly label: string; readonly text: string };

/** A tool call's result. */
export interface ResultEntry {
  readonly kind: 'result';
  readonly ts: number;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly interrupted: boolean;
  /** The result as text; images appear as `[image]`. */
  readonly output: string;
  readonly images: number;
  /** How the call was let run, or refused, when the agent recorded it. */
  readonly permission?: Permission;
}

/**
 * Who let a tool call run, or refused it: the person when they were asked (`by: 'you'`), else the
 * agent's own reason, such as a rule, a permission mode, or a classifier.
 */
export interface Permission {
  readonly allowed: boolean;
  readonly by: string;
}

/**
 * What the harness put in front of the model besides the prompts, the responses, and the results:
 *
 * - `instructions`: the project's or the person's instruction files.
 * - `memory`: memory files loaded along the way.
 * - `reminder`: reminders the harness adds, such as a token budget or a to-do list.
 * - `hook`: what the person's hooks added.
 * - `skill`: skill listings and the skills loaded.
 * - `tools`: listings of tools, agents, and servers, and their instructions.
 * - `environment`: the date, the working directory, the model, the output style, the mode.
 * - `file`: files, or changes to them, the harness attached.
 * - `command`: a slash command's expansion or output.
 * - `task`: a background task's report that did not start a turn.
 * - `message`: any other message, such as a prompt queued while the agent worked.
 */
export type ContextSource =
  | 'instructions'
  | 'memory'
  | 'reminder'
  | 'hook'
  | 'skill'
  | 'tools'
  | 'environment'
  | 'file'
  | 'command'
  | 'task'
  | 'message';

/** Something the harness put in front of the model. */
export interface ContextEntry {
  readonly kind: 'context';
  readonly ts: number;
  readonly source: ContextSource;
  /** What it is, in a few words, such as `Instructions · AGENTS.md`. */
  readonly label: string;
  /** The text the model saw. */
  readonly text: string;
}

/** A compaction of the context, with the summary that replaced it when the agent recorded it. */
export interface CompactionEntry {
  readonly kind: 'compaction';
  readonly ts: number;
  readonly trigger?: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
  readonly summary: string;
}

/** Something that happened that is not a message: an interrupt, a fallback to another model, a warning. */
export interface NoticeEntry {
  readonly kind: 'notice';
  readonly ts: number;
  readonly level: 'info' | 'warning' | 'error';
  readonly text: string;
}
