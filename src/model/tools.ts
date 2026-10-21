/**
 * What kind of work a tool call does. Analysis, report, and viewer group and color tool calls by
 * category, never by an agent's tool names; the adapter that loads a transcript picks the category.
 *
 * - `shell`: runs a shell command; grouped by command in the shell breakdown.
 * - `file`: reads or edits a file.
 * - `search`: searches file names or contents.
 * - `web`: fetches a URL.
 * - `agent`: starts a subagent, whose own transcript may be part of the session.
 * - `workflow`: starts a group of agents run by a script.
 * - `question`: asks the person a question; its time is charged to the person, not to a tool.
 * - `task-control`: stops background tasks (see {@link ToolDescription.stops}).
 * - `skill`: loads a skill or other packaged instructions.
 * - `other`: anything else.
 */
export type ToolCategory =
  'shell' | 'file' | 'search' | 'web' | 'agent' | 'workflow' | 'question' | 'task-control' | 'skill' | 'other';

/**
 * How a tool call reads to the agent-neutral layers. The adapter fills it when it loads the
 * transcript, from the call's name and input and the transcript's working directory.
 */
export interface ToolDescription {
  readonly category: ToolCategory;
  /**
   * One line that says what the call did: the file it read, the pattern it searched, the command it
   * ran. Shown in the report's slowest tool calls and timeline, and as the viewer's span label.
   * Empty when the input has nothing worth showing.
   */
  readonly preview: string;
  /**
   * The call's input as a person reads it: the shell command, a written file's path and content, an
   * edit's path with its old and new text, otherwise the input as pretty-printed JSON. The viewer's
   * detail pane shows it (clipped).
   */
  readonly inputText: string;
  /**
   * The agent's own note on what the call is for, when it gave one (a shell command's or a
   * subagent's description). The viewer's detail pane shows it.
   */
  readonly purpose?: string;
  /** The command a `shell` call ran; the shell breakdown groups calls by its key (util/shellKey). */
  readonly shellCommand?: string;
  /**
   * True when a `shell` call asked to run in the background: the shell breakdown adds ` [bg]` to
   * its key. The preview is the adapter's to mark; Claude Code's ends in `  [background]`.
   */
  readonly runsInBackground?: boolean;
  /**
   * For a `task-control` call, the ids of the background tasks it stops. When its result arrives,
   * every background task whose `backgroundIds` (see `ToolResultEvent`) include one of them ends.
   */
  readonly stops?: readonly string[];
  /** For a `file` call, the file it reads or writes, as its input names it. */
  readonly file?: { readonly path: string; readonly access: 'read' | 'write' };
}

/** A tool call the model asked for, as one of a response's tool calls. */
export interface ToolCall {
  /** The id that the call's tool result, and any background signal or notification for it, refer to. */
  readonly id: string;
  /** The agent's name for the tool, as shown in the report and the viewer (e.g. in bucket names). */
  readonly name: string;
  /** The call's raw input, for adapters and the detail pane; the neutral layers read {@link desc}. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly desc: ToolDescription;
}
