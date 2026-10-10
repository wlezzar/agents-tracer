# The model and the timing semantics

The neutral model (`src/model/`) is what adapters produce and every other layer reads. The timing semantics below are the analysis's (`src/analysis/`), ported from the prototype's `analyze`; the names of buckets and states are output and stay exactly as written here.

## Times

Every time is epoch milliseconds. Clock times in the report are local, as the person who ran the session read them.

## Events

A transcript's events (`TraceEvent`, discriminated on `kind`) are kept in file order; the analysis sorts them by `ts`, keeping file order between equal times, since records are not always written in time order (a compaction writes its summary late).

| Kind              | Fields                                                                                 | Meaning                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`          | `text`                                                                                 | A prompt, usually the person's; another origin's reads `[origin] text`. Starts a `you` turn.                                             |
| `notification`    | `text`, `toolCallId?`                                                                  | A background task reporting back as a turn of its own. Starts a `task` turn and ends the task.                                           |
| `command`         | `name`, `compaction`                                                                   | A local slash command. Starts a `command` turn; a compaction puts the session in the compaction state.                                   |
| `response`        | `messageId`, `model?`, `synthetic`, `stop`, `usage?`, `blocks`, `text`, `toolCalls`    | One record of a model response. Records that share `messageId` are one model call.                                                       |
| `tool_result`     | `toolCallId`, `isError`, `interrupted`, `output`, `async`, `backgroundIds`, `launches` | A tool call's result. `async`: its work goes on in the background; `launches`: the subagent (`agentId`) or group (`groupId`) it started. |
| `background_done` | `toolCallId`                                                                           | Out of band: the background task a call started has finished. May land mid-turn.                                                         |
| `compaction_done` | none                                                                                   | The compacted summary landed.                                                                                                            |
| `interrupt`       | none                                                                                   | The person interrupted the turn.                                                                                                         |

A response's `stop` (`StopReason`) and `blocks` use the Anthropic Messages API's vocabulary, which the analysis reads: `end_turn` and `stop_sequence` end the turn, `tool_use` asks for tools, `null` means the record has no stop reason; `thinking` and `redacted_thinking` blocks mark reasoning. An adapter for another API maps its values onto these. Stop reasons also decide whether a transcript's token counts are known: when more than a tenth of its model calls have none (`usageKnown`), the report prints `tokens not recorded (subagent transcript)` and `-` for its counts, and the viewer leaves them out.

## Tool calls

A `ToolCall` has the agent's `name` for the tool, its raw `input`, and a `ToolDescription` the adapter fills in:

- `category`: `shell`, `file`, `search`, `web`, `agent`, `workflow`, `question`, `task-control`, `skill`, or `other`. The neutral layers decide by category, never by name: a `question` call's time is the person's; `shell` calls make the shell breakdown; `task-control` calls stop background tasks.
- `preview`: one line saying what the call did. `inputText`: the input as a person reads it. `purpose`: the agent's own note on the call, if any.
- `shellCommand` and `runsInBackground` for `shell` calls: the breakdown groups calls by `shellKey(shellCommand)`, plus ` [bg]` for background ones. A shell key is the first command that is not plumbing (`cd`, `export`, loops, …), with the subcommand for the tools in util's `SUBCOMMAND_TOOLS` (`git log`, `pnpm test`) and for the tools `subcommandTools` adds (`LoadOptions`, the report's and the view's options; the CLI reads them from `AGENTS_TRACER_SUBCOMMAND_TOOLS`).
- `stops` for `task-control` calls: the ids of the background tasks it stops.

## Transcripts and sessions

A `Transcript` is one file: `id` (its file name without the extension), `path`, `title?`, `cwd?`, `events`, and `compactions`. A `Session` is the main transcript with the subagent transcripts (`AgentTranscript`: `id`, `description?`, `phase?`, `agentType?`, `background`, `group`) and the groups they ran in (`Group`: `id`, `kind`, `label`, `name?`, `status?`, `durationMs?`, `totalTokens?`, `totalToolCalls?`, where `kind` is what the agent calls such a group, such as `Workflow`, which heads the group in the report), plus `shellToolName?`, the agent's name for its shell tool. Loading a subagent's transcript directly makes it the main transcript of a session without agents.

An agent's parent is the transcript (the main one or another agent's) holding the tool result whose `launches.agentId` is the agent's id; an agent in a group without one has the main transcript as its parent. An agent is nested when its parent is not the main transcript.

## Timing

The analysis walks a transcript's sorted events and charges each gap between consecutive events to one bucket: what was pending during the gap.

### States

- `start`: before the first event; nothing is charged.
- `model`: the model is generating.
- `tools`: at least one tool call is outstanding.
- `idle`: the agent waits for the person, or for a background task.
- `compaction`: the context is being compacted.

The analysis also tracks the outstanding tool calls, in the order they were asked for, and the background tasks: async tool calls whose task has not ended.

### Buckets

| Bucket                                           | Charged when the gap ends at an event and …                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `compaction`                                     | the state is `compaction`, or the event is `compaction_done`                             |
| `model`                                          | the event is a `response`, or the state is `model`                                       |
| `tool:<name>`                                    | a tool call was pending (see below)                                                      |
| `you: answering questions`                       | the pending tool call is a `question`                                                    |
| `tool:?`                                         | a tool result arrives, or the state is `tools`, with no outstanding call to charge it to |
| `idle: waiting on a background task`             | the state is `idle` and the event is a `notification`                                    |
| `idle: waiting on you, background tasks running` | the state is `idle` and background tasks are running                                     |
| `idle: waiting on you`                           | the state is `idle` otherwise                                                            |

For every event but `background_done`, the first rule that applies picks the bucket of the gap that the event ends:

1. state `start`: nothing;
2. state `compaction`: `compaction`;
3. a `response`: `model`;
4. a `tool_result`: the tool bucket of the call it answers when that call is outstanding, otherwise of the first outstanding call, otherwise `tool:?`;
5. a `compaction_done`: `compaction`;
6. state `idle`: `idle: waiting on a background task` for a `notification`, else `idle: waiting on you, background tasks running` when background tasks are running, else `idle: waiting on you`;
7. state `tools`: the tool bucket of the first outstanding call, or `tool:?`;
8. otherwise (state `model`): `model`.

A call's tool bucket is `you: answering questions` for a `question` call and `tool:<name>` for any other. Active time is the sum of every bucket that does not start with `idle`; `you: answering questions` is active.

A gap longer than zero is added to its bucket and to the segments; a bucket that is not idle is also added to the current turn's buckets; an idle gap of at least the minimum idle (`--min-idle`, 1 second by default) becomes a timeline item.

### Background tasks and `background_done`

`background_done` is out of band. When it lands while the state is `idle`, after the previous event, it splits the idle gap: the part up to it is charged as `idle: waiting on a background task` when the next event that is not a `background_done` is a `notification`, otherwise as `idle: waiting on you, background tasks running` when background tasks were running (the finishing one included), else `idle: waiting on you`; the rest of the gap then runs from it. In any other state it charges nothing. Either way, it ends its task and sets the launching call's `bgEnd` if unset.

A background task starts when an `async` result arrives and ends at the first `background_done` or `notification` for its call, or when a `task-control` call's result arrives whose `stops` include any of the task's `backgroundIds`.

### Transitions

| Event             | Effect                                                                                                                            | State after                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response`        | Adds the record to its model call; its tool calls become outstanding.                                                             | `tools` if a call is outstanding; else `idle` if `stop` is `end_turn` or `stop_sequence`; else `model`. At the last record of its message, `model` becomes `idle` unless `stop` is `tool_use`. |
| `tool_result`     | Completes its call; an `async` one starts a background task; a `task-control` one stops tasks. The call is no longer outstanding. | `tools` if a call is outstanding, else `model`.                                                                                                                                                |
| `prompt`          | Starts a `you` turn.                                                                                                              | `tools` if a call is outstanding, else `model`.                                                                                                                                                |
| `notification`    | Ends its task; starts a `task` turn.                                                                                              | `tools` if a call is outstanding, else `model`.                                                                                                                                                |
| `command`         | Starts a `command` turn.                                                                                                          | `compaction` if it is a compaction, else `idle`.                                                                                                                                               |
| `compaction_done` | none                                                                                                                              | `idle`                                                                                                                                                                                         |
| `interrupt`       | Drops every outstanding call; a timeline item.                                                                                    | `idle`                                                                                                                                                                                         |
| `background_done` | Ends its task (see above).                                                                                                        | unchanged                                                                                                                                                                                      |

### What the analysis produces

`analyzeTranscript(transcript, { minIdle })` (`src/analysis/analyze.ts`) returns a `TranscriptAnalysis` (`src/analysis/types.ts`):

- **`buckets`**: bucket → milliseconds, in the order buckets were first charged (the report and the view sort them stably, so this order breaks ties).
- **`segments`**: `[start, end, bucket]` in time order, one per charged gap, adjacent equal buckets merged. They are contiguous from the first charged gap to the last, and bucket sums equal segment sums.
- **`calls`** (`ModelCall`), one per `messageId`, in the order of their first records: `ts` is the first record's time; `start` is the previous event's time when the first record's gap was model time, else `ts`; `end` is the last record's time; `ms` is the model time charged to its records; `model` and `synthetic` from the first record, the last `usage` reported, the last record's `stop`, every record's `blocks`, the texts joined by a space, the tool calls (`ToolRun`s), and the turn it began in.
- **`tools`** (`ToolRun`), one per tool call id, in the order first asked for (a call id asked for twice keeps its first place and its last request): `id`, `name`, `input`, `desc`; `start`, the time of the response record that asked for it; `end`, the time of its last result, and `ms`, `end - start`; from its last result, `interrupted`, `async`, `output`, `launches`, and `backgroundIds`; `isError`, when its last result is an error or its result before that was interrupted; `bgEnd`, the first `background_done` or `notification` for it; and the turn it was asked in. A call without a result has no `end` and no `ms`, `output` is empty, and its flags are false.
- **`turns`** (`Turn`): `n` from 1, `ts`, `kind` (`you`, `task`, or `command`), `text` (the prompt, the notification's text, or the command's name), its non-idle `buckets`, the model calls that began in it (`calls`) and the tool calls asked for in it (`tools`), `out`, the output tokens of the calls whose last record fell in it, and `end`, the time of its last response, tool result, compaction end, or interrupt (its start when it has none).
- **`timeline`** (`TimelineItem`), in walk order: an idle gap of at least `minIdle` seconds (1 by default) at the event that ends it, a turn as it starts, a model call at the last record of its message, a tool call at each of its results, an interrupt. A gap is charged before the event that ends it is handled, so the idle item before a turn comes before that turn's item. Items refer to the analysis's calls, tool calls, and turns, whose fields are final.
- **`start`** and **`end`**: the first and last events' times, `background_done` included; `undefined` without events (`wallOf` is then NaN). **`models`**: the non-synthetic calls' models in order of first use.
- **`events`**: the events in the order walked; **`transcript`**: the transcript analyzed.

Usage is known (`usageKnown`) when at least 90% of a transcript's model calls have a stop reason; otherwise its token counts are reported as unknown rather than small, since a transcript written mid-stream (as subagent transcripts are) records usage only as far as it had streamed.

`analyzeSession(session, options)` analyzes the main transcript and every agent's, and returns a `SessionAnalysis`: `main`, and `agents` (`AgentAnalysis`, in the session's order), each with its `analysis`; its `parent`, as defined under [Transcripts and sessions](#transcripts-and-sessions): `MAIN` (the string `'main'`) for the main transcript, another agent's id, or `null` when nothing launched it and it is in no group (when several transcripts launched it, an agent's launch wins over the main transcript's, a later agent's over an earlier one's); `nested`; and `launcher`, the main transcript's tool call that launched it (the last, when several did).

The aggregates the report and the view share (`src/analysis/aggregates.ts`): `isIdle`, `bucketOf` (a tool call's bucket), `activeOf` (all but idle), `sumTools` (the `tool:` buckets), `youOf` (waiting on the person, with or without tasks running, and answering questions), `wallOf`, `usageKnown`, `usageTotals`, `topTools` (the largest `tool:` and `you:` buckets, `Read 4.0s, …`), `shellBreakdown` (the `shell` calls with a result by `shellKey`, plus ` [bg]` for background ones, the largest sum first), and `callSummary` (`[synthetic] · thinking · Read ×2 · “text”`).

## Caveats

- A tool's time includes any permission prompt it waited on.
- Parallel tool calls: each gap that ends at a result is charged to the call that result answers, so per-tool sums of wall time never exceed the wall. Per-call durations overlap, so the shell breakdown's sums of call durations can exceed it.
- The part of an idle gap before a `background_done` is charged but makes no timeline item; only the rest of the gap can.
- `failed` in the report means `isError` only; interrupted calls are counted apart. As in the prototype, a call that gets a second result is also failed when its earlier result was interrupted.
- Time before the first event and after the last is not charged, and neither is a `background_done` outside an idle gap, so a transcript that begins or ends with such events has a `start` or `end` beyond its segments.
