# agents-tracer

Where did the time go in a coding-agent session?

agents-tracer reads a coding agent's local session transcripts, rebuilds the session's timeline, and charges every moment of wall-clock time to what was pending: the model generating, a tool running, you (between turns, or answering the agent's questions), a background task, or compaction. It shows the result as a text report, as an interactive HTML timeline in one self-contained file, or from a local web server that browses every session of a project.

Claude Code is the first agent it reads. Its model of a session is agent-neutral, so adapters for other coding agents can plug in without changing the analysis, the report, or the viewer.

## Install from source

agents-tracer needs Node 24 or later and pnpm (the versions are pinned in `mise.toml`; with [mise](https://mise.jdx.dev), `mise install`).

```bash
git clone https://github.com/wlezzar/agents-tracer.git
cd agents-tracer
pnpm install
pnpm build
node dist/cli/main.js --help
```

To have it on your path, put `agents-tracer` where your shell looks, pointing at the build: `ln -s "$PWD/dist/cli/main.js" ~/.local/bin/agents-tracer`.

## Usage

```text
agents-tracer list
agents-tracer report <session> [--timeline] [--turn <n>] [--top <n>] [--no-subagents] [--min-idle <seconds>]
agents-tracer html <session> [--out <file>]
agents-tracer serve [--port <n>]
```

Every command takes `--adapter <id>` (the agent, `claude-code` by default) and `--store <dir>` (the directory of the project's sessions; by default the agent's directory for the current one, such as `~/.claude/projects/-home-dev-shop` for Claude Code in `/home/dev/shop`; `--project` is an alias). A `<session>` is a session's id or a prefix of it, a subagent's id or a prefix of it, or the path of a transcript. Clock times are local.

Shell commands are grouped by what they ran: the first command that is not plumbing (`cd`, `export`, loops, …), with its subcommand for `pnpm`, `npm`, `yarn`, `npx`, `git`, `mise`, `docker`, `aws`, and `gh` (`pnpm test`, `git log`). To key your own tools by their subcommand too, name them in `AGENTS_TRACER_SUBCOMMAND_TOOLS`, separated by commas or spaces: `AGENTS_TRACER_SUBCOMMAND_TOOLS=kubectl,terraform agents-tracer report 5e1f`.

The examples below run on the synthetic sessions in `test/fixtures/claude-code/store`, so you can try them from a checkout with `--store test/fixtures/claude-code/store`; they were printed in the `Europe/Paris` time zone (`TZ=Europe/Paris`).

### list

The project's sessions, oldest first: the id's first 8 characters, when it started, its wall time, the transcript's size, and its title or first prompt.

```console
$ agents-tracer list
session   start               wall  size  title / first prompt
5e9b7c6d  2026-03-10 10:00   6m40s   12K  Add a test for the cart total
c3d4e5f6  2026-03-12 15:00  20m08s    8K  Cart store reducer
5e1f0c2a  2026-03-14 23:50   1h31m   39K  Cart badge in the header
```

### report

Where one session's time went. Every stretch of wall time is charged to what was pending: `model` (generating), `tool:<name>` (a tool running, including any permission prompt it waited on), `you: answering questions` (the agent asked you), `compaction`, or one of the idle buckets: waiting on you, waiting on you while background tasks run, or waiting on a background task. Then come the shell commands grouped by what they ran, the slowest tool calls (✗ for a failed one) and model responses, the turns, and the subagents, which run alongside the session, so their time overlaps it.

```console
$ agents-tracer report 5e1f
5e1f0c2a-8b3d-4c6e-9f7a-1d2b3c4d5e6f  “Cart badge in the header”
  2026-03-14 23:50 → 2026-03-15 01:21  ·  1h31m wall  ·  9m25s active
  21 API calls (claude-opus-4-1, claude-sonnet-4-5)  ·  16 tool calls  ·  2.2k output, 390.3k cache-read, 35.0k cache-write, 47 uncached input tokens

Where the time went
                                                    time  active  count
  model                                            3m49s     41%  21
  tool:Bash                                        3m32s     38%  6
  you: answering questions                         2m00s     21%  1
  tool:Agent                                        1.0s      0%  1
  …
  idle: waiting on you                            52m20s
  idle: waiting on you, background tasks running  23m15s
  idle: waiting on a background task               6m20s

Bash by command (sum of call durations)
                         time  calls    max  failed
  pnpm test             1m30s      2    45s  1
  pnpm exec playwright  1m00s      1  1m00s  1
  pnpm lint             1m00s      1  1m00s
  …

Slowest tool calls
  #2  03-14 23:53:41  2m00s  AskUserQuestion  Should the badge hide when the cart is empty?
  #3  03-15 00:10:10  1m00s  Bash             Run the e2e tests · pnpm exec playwright  ✗
  …

Slowest model responses
  …

Turns (active time only; idle time is between turns)
  …

Subagents (they run alongside the session, so their time overlaps it)
  start            wall  model  tools  calls  out  top tools              agent
  03-15 00:12:11  7m47s  7m46s   1.2s      3    -  Agent 1.0s, Read 0.2s  Review the cart badge [background, a1b2c3d4e]
  …
```

A session that spans days shows each clock time with its date. A transcript written mid-stream, as subagents' transcripts often are, records no stop reasons and only part of its token counts, so its counts show as `-` (or `tokens not recorded`) rather than as small numbers.

- `--timeline` adds every model call, tool call, idle gap of at least `--min-idle` seconds (1 by default), and interrupt, in order, under a heading per turn; `--turn <n>` shows only turn `n`.
- `--top <n>` sets the rows of the by-command and slowest tables (10 by default).
- `--no-subagents` leaves the subagents out.

```console
$ agents-tracer report 5e1f --timeline --turn 3
…
── #3 03-15 00:10:00 you: Look at the design mock and run the e2e tests
03-15 00:10:04    4.0s  model         60 out  Read docs/badge-mock.png
03-15 00:10:04    0.3s  Read       docs/badge-mock.png
03-15 00:10:10    5.7s  model         75 out  Bash Run the e2e tests · pnpm exec playwright
03-15 00:11:10   1m00s  Bash       Run the e2e tests · pnpm exec playwright  ✗
03-15 00:11:10          ⏹ interrupted
03-15 00:12:00     50s  … waiting on you, background tasks running
```

### html

An interactive timeline of a session and its subagents, in one self-contained HTML file that opens in any browser, offline.

```console
$ agents-tracer html 5e1f
Wrote /home/dev/.cache/agents-tracer/html/5e1f0c2a-8b3d-4c6e-9f7a-1d2b3c4d5e6f.html (117K)
```

By default the file goes to `agents-tracer/html/<session id>.html` under `$XDG_CACHE_HOME`, or under `~/.cache` when that is unset or relative; `--out <file>` writes it elsewhere.

The page shows:

- **Stats** of the lane you are looking at: wall clock, active time and its shares (model, tools), the time spent waiting on you, model and tool calls, and tokens.
- **The timeline**: one lane per transcript, the session first, then its subagents under a header per group (such as a workflow run; click the header to collapse it). Each lane has a state track of what was pending, stretch by stretch, a row of model responses, and rows of tool calls, colored by kind (the model, the shell, other tools, and the kinds of waiting), with failed calls marked, background tasks drawn until they reported back, and turn markers. Idle stretches of two minutes or more are collapsed (untick _Collapse idle stretches_ to see real time), and the overview below shows the whole session and the window you are looking at.
- **Panels** for the current lane: _Trace_ (every span, turn, and long idle stretch, filtered by text, kind, or the visible range, sorted by start or duration), _Turns_, _Breakdown_ (where the time went, the shell commands by what they ran, the slowest calls, compactions), and _Agents_. Selecting a span shows its detail: when it ran, its turn, its tokens, the command or input and the output (with copy buttons), and the agent or the group of agents it launched.

Drag to pan; Ctrl, ⌘, or Alt with the wheel, a pinch, or W and S zoom; A and D pan; F fits; drag across the time axis to zoom to a range; double-click zooms to a span; J and K step through spans; Escape clears the selection; `/` jumps to the filter; click a lane's name to show its panels. The theme button cycles between the system's theme, light, and dark, and the page remembers it.

### serve

A web server that lists the project's sessions, newest first, and shows each one's timeline (`/s/<session id>`), built when you open it and kept until the session's transcript or one of its subagents' changes, so a session that is still running shows its latest state on reload.

```console
$ agents-tracer serve
Serving /home/dev/.claude/projects/-home-dev-shop on http://127.0.0.1:4390/
```

`--port <n>` picks another port (`--port 0` lets the system pick one). Transcripts hold everything a session saw, so the server listens on the loopback interface, 127.0.0.1, only, takes a session by its id, never by a path, and answers only requests addressed to `127.0.0.1` or `localhost` (on any port), so that a web page whose domain is pointed at your machine cannot read your sessions. To browse sessions that live on another machine, such as a cloud desktop, forward the port over SSH and open `http://127.0.0.1:4390/` on yours:

```bash
ssh -N -L 4390:127.0.0.1:4390 dev-box
```

agents-tracer only reads transcripts. It prints the control characters a transcript's text may hold as visible stand-ins (`␛` for ESC), so that none can drive your terminal. Errors print one line to standard error, and the command exits with status 1.

## Development

See [AGENTS.md](AGENTS.md) for the commands and the rules, and [docs/](docs/) for the [architecture](docs/architecture.md), the [model and its timing semantics](docs/model.md), and [how to add an adapter](docs/adapters.md).
