# Adapters

An adapter reads one coding agent's local transcripts into the neutral model ([model.md](model.md)). It is the only code that knows the agent: where its transcripts live, how its records are written, and what its tools are called. The analysis, the report, the view, the viewer, the server, and the CLI read only what adapters return, so adding an agent means adding an adapter and nothing else.

## The interface

`Adapter` (`src/model/adapter.ts`):

```ts
interface Adapter {
  readonly id: string; // what --adapter takes, such as 'claude-code'
  readonly displayName: string; // such as 'Claude Code'
  defaultStore(cwd: string, home: string): string; // the store of the project in cwd
  listSessions(store: string): SessionSummary[]; // oldest first; sessions with no timestamp left out
  resolve(store: string, ref: string, options?: ResolveOptions): string; // a path, or throws an Error saying why not
  load(path: string, options?: LoadOptions): Session; // the transcript, with its subagents and groups
  version?(path: string): string; // changes whenever what load(path) reads changes
}
```

- A store is the directory that holds one project's sessions. Synchronous file IO is fine. The interface has no notion of a project inside a store: `listSessions(store)` lists every session of the store, and `defaultStore(cwd, home)` is how the current project is chosen. That fits an agent that keeps each project's sessions in a directory of their own, as Claude Code does; for an agent that keeps every project's sessions in one tree, the interface will need a way to filter a store by project (such as `listSessions(store, { cwd })`) when such an adapter is written.
- `displayName` heads the server's index page (`Claude Code sessions`) and the help.
- Session ids (`SessionSummary.id`, and the ids `resolve` accepts) that the server can open are ASCII letters, digits, `_`, and `-`: it serves `/s/<id>` only for such ids, so that a URL never holds a path, and lists a session with any other id without a link. Keep ids that way, such as a file's name without its extension when that is a uuid.
- `resolve` accepts an existing file path, a session id or a unique prefix of one, and a subagent id or a unique prefix of one. Its errors are shown to the person as they are (by the CLI, and by the server as a 404), so they say what matched: no session, or how many. With `{ paths: false }` (`ResolveOptions`) it must not take `ref` as a path, only as an id: the server passes it, so that a reference from a URL never names a file.
- `version(path)`, if the adapter has it, is a stamp of everything `load(path)` reads, which changes whenever any of it does: Claude Code's is the count, total size, and newest modification time of the transcript and of every file under the session's `subagents/` and `workflows/`. The server keeps a session's page until its version changes; without `version`, it builds the page on every request. An adapter whose sessions never change (such as the memory adapter) can return a constant.
- `load` returns a `Session` whose events are in file order (the analysis sorts them), whose tool calls carry a filled-in `ToolDescription`, and whose `shellToolName` is the agent's name for its shell tool, if it has one: it titles the report's shell breakdown and names the shell in the viewer's legend, trace filter, and breakdown (`Shell` when absent). Loading a subagent's transcript directly returns a session with that transcript as `main` and no agents.
- `load`'s `LoadOptions` carry `conversation`: when true, fill each transcript's `conversation` ([model.md](model.md#the-conversation)), and its `requestShapes` when the agent records its requests, with what it says, as a person reads it: the prompts, the responses' blocks (the reasoning's text when the agent records it), the results with who let each call run, what the harness put in front of the model, compactions, and notices. It is optional: an adapter that leaves `conversation` absent gets a conversation built from its events. Make one prompt entry for each `prompt`, `notification`, and `command` event, in the same order, so the turns agree, and leave the events as they are whether or not the conversation is read.
- `load`'s `LoadOptions` also carry `subcommandTools`, the person's own tools whose subcommand belongs in a shell command's key (the CLI reads them from `AGENTS_TRACER_SUBCOMMAND_TOOLS`). An adapter that shows shell keys in its previews, as Claude Code's does (`Run the tests · pnpm test`), passes them to util's `shellKey`; any other adapter can ignore them.
- Parse every record as `unknown` and narrow it; tolerate a partial last line, since a session being written can end in one. `src/util/json.ts` has the helpers: `parseJsonLines`, `isRecord`, `stringOr`, `numberOr`, and `jsText` and `looseText`, which convert a loosely typed value to text as JavaScript's `String` does without a type assertion.

`src/adapters/registry.ts` holds `createRegistry(adapters, defaultId)`, which builds an `AdapterRegistry` whose `get(id)` throws an error naming the known ids, and `registry`, the shipped adapters (Claude Code, the default), which the CLI and the server use.

## Adding an adapter

1. Create `src/adapters/<id>/`, with an `index.ts` that exports the adapter. It may import `src/model/`, `src/util/`, its own modules, and Node built-ins (with the `node:` prefix); no other layer, no other adapter, and no package (the `agents-tracer/layers` ESLint rule enforces this).
2. Map the agent's records to `TraceEvent`s. Decide, for each kind of record, which event it is or whether it is skipped; the analysis's semantics are in [model.md](model.md), so an event's meaning, not the record's name, decides. Map stop reasons and content block types onto the vocabulary `ResponseEvent` documents: the analysis reads only the stop reasons `end_turn` and `stop_sequence` (the turn ends) and `tool_use` (the model asks for tools), typed as `StopReason`, and the block types `thinking` and `redacted_thinking`. Give every complete response its stop reason: when more than a tenth of a transcript's model calls have `stop: null`, its token counts are taken as not recorded, and the report and the viewer leave them out (this is how a subagent transcript written mid-stream reads).
3. Describe every tool: pick its `ToolCategory`, and fill `preview`, `inputText`, and, where they apply, `purpose`, `shellCommand`, `runsInBackground`, and `stops`. The shell breakdown adds ` [bg]` to the key of a call that `runsInBackground`; the preview is the adapter's alone, so to mark such a call there, end it with `  [background]` as Claude Code's does. Unknown tools are `other`, with their input as JSON.
4. Find the subagent transcripts and groups that belong to a session, and link them: a tool result's `launches.agentId` must equal the `AgentTranscript.id` it started, and `launches.groupId` the `Group.id`. Name each group's `kind` (what the agent calls such a group; the report heads the group with it, and the viewer's detail pane names it) and `label` (how the viewer names it).
5. Register the adapter in `src/adapters/registry.ts`.
6. Add synthetic fixtures under `test/fixtures/<id>/`, hand-written with fake paths and prompts (never a real transcript; see the privacy rule in [AGENTS.md](../AGENTS.md)), and tests of the mapping next to the adapter. To test the commands over the adapter, pass a registry that holds it to `runCli` (`test/support/cli.ts`), as `test/cli.test.ts` does with the memory adapter; to test the view, build it with `viewSession(adapter.load(…))`, and to test it served, start the server over the adapter (`startServer` in `src/server/`), as `test/neutral-view.test.ts` does.
7. Add the agent's vocabulary to `eslint/boundaries.mjs`, under the adapter's id: `agent` (its name, for the messages), `words` (a pattern of what no string literal outside the adapters may hold: tool names unlikely to be ordinary words, file names, record fields), and `tools` (every tool name the adapter knows, which no code outside the adapters may match a value against). Every adapter's directory is exempt, the new one's included, so the adapter itself may name them; ESLint refuses them in the rest of `src/`, and `test/boundaries.test.ts` fails until every shipped adapter has an entry.
8. Update this document and the README.

## The example: the memory adapter

`test/support/memory-adapter.ts` is a complete, if minimal, adapter that is not shipped: it serves sessions built in memory from neutral events, so tests of the analysis, the report, and the view run without any transcript format (`test/neutral-analysis.test.ts`, `test/neutral-report.test.ts`, `test/neutral-view.test.ts`). It shows the smallest thing an adapter must provide:

```ts
import { createMemoryAdapter, session, toolCall, transcript } from '../support/memory-adapter.js';

const t0 = Date.UTC(2026, 0, 5, 9, 0);
const adapter = createMemoryAdapter([
  session(
    transcript('aaa111', [
      { kind: 'prompt', ts: t0, text: 'Add a cart badge' },
      {
        kind: 'response',
        ts: t0 + 2000,
        messageId: 'm1',
        model: 'model-a',
        synthetic: false,
        stop: 'tool_use',
        blocks: ['tool_use'],
        text: '',
        toolCalls: [toolCall('c1', 'Shell', 'shell', { shellCommand: 'pnpm test' })],
      },
      // …
    ]),
    { shellToolName: 'Shell' },
  ),
]);
const loaded = adapter.load(adapter.resolve('memory:', 'aaa'));
```

## The Claude Code adapter

`src/adapters/claude-code/` reads Claude Code's transcripts, ported from the prototype's `readJsonl`, `classify`, `textOf`, `toolPreview`, `inputText`, `findSubagents`, `workflowSummary`, `listSessions`, and `resolve`. It produces the prototype's events exactly: over every local transcript, its events, previews, input texts, listings, and resolutions equal what the prototype computes (see Parity in [AGENTS.md](../AGENTS.md)).

| Module            | Holds                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | `claudeCode`, the `Adapter` (its `version` is `store.ts`'s `sessionVersion`), and `loadSession`, which reads a session with its subagents and workflow runs, or a subagent's transcript alone (a path under `/subagents/`). |
| `classify.ts`     | `classify(records)`: the events, working directory, title, and compactions of a transcript's records; `textOf`.                                                                                                             |
| `conversation.ts` | `conversationOf(records, cwd)`: the conversation of a transcript's records; `requestShapesOf(records)`: the system prompts and tools its requests were sent with.                                                           |
| `tools.ts`        | `describeTool(name, input, cwd)`: a tool's category, preview, input text, purpose, and shell or task-control fields; `toolPreview`, `inputText`, `categoryOf`, `SHELL_TOOL`.                                                |
| `store.ts`        | `defaultStore`, `listSessions`, `resolve`, `readTranscript`, `findSubagents`, `workflowSummary`, `sessionVersion`: where transcripts live and how they are found.                                                           |

- **Store**: `~/.claude/projects/<cwd with every character outside [a-zA-Z0-9] replaced by ->`. Sessions are `<store>/<id>.jsonl`. Subagents live under `<store>/<id>/subagents/**` as `agent-<agentId>.jsonl`, beside `agent-<agentId>.meta.json` (`description`, `workflowPhase`, `agentType`, `requestShape: 'background'`). Workflow runs' agents are under `subagents/workflows/<runId>/`, and a run's summary is `<store>/<id>/workflows/<runId>.json` (`workflowName`, `status`, `durationMs`, `totalTokens`, `totalToolCalls`).
- **Records to events**:
  - a `queue-operation` enqueue's content, or a `queued_command` attachment's prompt, that holds `<tool-use-id>` → `background_done`;
  - `assistant` → `response` (synthetic when the model is `<synthetic>`; usage from `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`);
  - a `user` record's `tool_result` blocks → `tool_result`, one per block (`async` when `toolUseResult` has `isAsync`, status `async_launched`, or a `backgroundTaskId`; `backgroundIds` from `taskId`, `backgroundTaskId`, `agentId`; `launches.agentId` from `agentId` and `launches.groupId` from `runId`; `interrupted` from `interrupted`);
  - otherwise a `user` record is skipped when `isMeta`; `isCompactSummary` → `compaction_done`; text starting `[Request interrupted` → `interrupt`; origin `human` → `prompt`; a `task-notification` origin or text → `notification` (text from `<summary>`, call from `<tool-use-id>`); another origin → `prompt` `[kind] text`; `<command-name>` → `command` (a compaction when the name is `/compact`); other `<` wrappers are skipped; in transcripts without any origin field (the older format), the remaining text → `prompt`.
  - `ai-title` sets the title (the last wins), the first `cwd` wins, and `compact_boundary` records' `compactMetadata` are the compactions. Records without a timestamp make no event but still count for these.
  - A response's `messageId` is the message's `id`, else the record's `uuid`; its `blocks` are every content block's type, its `text` the text blocks joined by a space. A result's `output` is its content's text, with non-text parts as `[type]`; every tool_result block of a record reads that record's one `toolUseResult`.
- **Records to the conversation** (`conversationOf`, only with `LoadOptions.conversation`; the events are classify's either way):
  - `assistant` → `response`, a block per content block: `thinking` (its `thinking` text, and the record's `thinkingDurationMs`), `redacted_thinking`, `text`, `tool_use`, and any other type as `other`; `isApiErrorMessage` → `error`; its `requestRef` names the `api-request` record whose `shapeHash` and `params` (`model`, `output_config.effort`, `max_tokens`, `thinking`) are its `request`;
  - `api-request-shape` records → the transcript's `requestShapes` (`requestShapesOf`), one per `shapeHash`: the `shape`'s `system` blocks' text and its `tools` (`name`, `description`, `input_schema`, `defer_loading`); `api-request-blob` records, the messages themselves, are not read;
  - a `user` record's `tool_result` blocks → `result` (images counted; `permission` from the record's `permissionDecision`, `by` `you` for a `user…` source, else its `reasonType` or `source`; else from `toolDenialKind`), and its text blocks beside them → `context`;
  - an `attachment` with a `rendered` text (what the model saw) → `context`, its source and label from its type (`instructions` with its files, `nested_memory` with its path, `hook_additional_context` with the hook and its event, `skill_listing`, `total_tokens_reminder`, `queued_command`, …; an unknown type is named after itself); an attachment without one was not shown to the model and is left out;
  - `system` records: `compact_boundary` → `compaction`, whose summary is the next `isCompactSummary` user record's text; `local_command` → `context` (`Command output`); `turn_duration` and `away_summary`, which only the person sees, are left out; any other → `notice`, at the record's level;
  - other `user` records as classify reads them: where classify makes a `prompt`, `notification`, or `command`, a `prompt` (`by` `you`, `task` with its `<summary>`, `command` with its arguments; text blocks that are `<system-reminder>`s follow it as `context`); an interrupt → `notice` with `interrupt`; an `isMeta` record, a `<…>` wrapper, or other text → `context`, by its first tag (`system-reminder`, `command-message`, `local-command-stdout`, `bash-input`, …) or its start (`Base directory for this skill` is a skill).
- **Sessions**: `load` finds a session's subagents depth first under `subagents/`, in the directories' order (so `Session.agents` keeps the file system's order, which the report and the view only use to break ties). An agent's `description`, `phase` (`workflowPhase`), and `agentType` come from its meta file, `background` is `requestShape === 'background'`, and `group` is its workflow run's id. Each run with agents is a `Group` of kind `Workflow`, labeled `Workflow <workflowName>`, with its summary's `name`, `status`, `durationMs`, `totalTokens`, and `totalToolCalls`.
- **Tools**: `Bash` → `shell`; `Read`, `Write`, `Edit`, `NotebookEdit` → `file` (paths relative to the cwd when inside it); `Grep`, `Glob` → `search`; `WebFetch` → `web`; `Agent`, `Task` → `agent`; `Workflow` → `workflow`; `Skill` → `skill`; `AskUserQuestion` → `question`; `TaskStop` → `task-control` (`stops` its `task_id`); anything else → `other`. A file tool's `file` is its `file_path` (or `notebook_path`), read by `Read` and written by the others. A tool's `description` input, when it is a string, is its `purpose`. `shellToolName` is `Bash`.
- **Listing**: a session's `start` and `end` are its first and last timestamped records of any type (so they can differ from the analysis's, which counts only events); its `firstPrompt` is the first non-meta `user` record with a `human` origin, or, without an origin, a string that does not start with `<`.
- **Tolerance**: no record shape throws. Where the prototype would throw or carry a value of an unexpected type along, the adapter reads a missing id as empty, a non-object input as `{}`, a non-string text field as absent, and a malformed meta or summary file as empty; otherwise loosely typed values convert to text as the prototype's `String` calls do (`jsText`, `looseText`). Claude Code never writes those shapes, so parity is unaffected.
- **Fixtures**: `test/fixtures/claude-code/store/` and, for the conversation, `test/fixtures/claude-code/conversation/`, described in their README; `test/support/fixtures.ts` names their paths and session ids.
