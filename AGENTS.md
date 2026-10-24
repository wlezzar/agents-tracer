# agents-tracer

agents-tracer answers "where did the time go?" for coding-agent sessions. It reads an agent's local session transcripts, rebuilds a timeline, charges every moment of wall-clock time to what was pending (the model generating, a tool running, the person, a background task, compaction), and presents it as a text report, a self-contained HTML timeline, or a loopback web server that browses every session. It also shows what each session said, turn by turn (prompts, reasoning, replies, tool calls with their inputs and outputs, and what the harness added), as a conversation page or as Markdown, to find what to improve in a person's harness. Claude Code is the first adapter; the model and the analysis are agent-neutral so that other agents' adapters plug in without touching anything else.

It is a TypeScript port of a JavaScript prototype (`trace.mjs` and `viewer.html`), which stays the source of truth for behavior: see [Parity](#parity-with-the-prototype).

## Commands

Run `mise install` once to get the pinned Node and pnpm, then:

```bash
pnpm install
pnpm build          # tsc emits dist/; esbuild bundles the viewer client into dist/viewer/viewer.html
pnpm typecheck      # tsc over the Node code and, separately, the browser client and the browser tests
pnpm lint           # type-aware ESLint, including the layer rule and the adapter boundary
pnpm format         # Prettier; pnpm format:check only checks
pnpm test           # vitest: unit and integration tests
pnpm test:e2e       # build, then drive the viewer (html and serve over the fixtures) in Playwright's Chromium
pnpm check          # the full gate: typecheck, lint, format:check, test, build
pnpm parity         # build, then compare the CLI with the prototype over every local Claude Code store (or the stores given)
pnpm tracer <args>  # build, then run the CLI, such as pnpm tracer report 3f2a or pnpm tracer transcript 3f2a
node scripts/expectations.ts  # rewrite test/fixtures/claude-code/expected/ (report texts and view data) from the prototype, after a fixture or a case changes
```

Playwright's Chromium comes from `~/.cache/ms-playwright`; when it is missing, `pnpm exec playwright install chromium`.

## Layout and dependency rules

```text
src/
  model/        neutral types: events, conversation entries, transcripts, sessions, tool descriptions, the adapter interface
  util/         pure helpers: durations, token counts, local clock and day, oneLine, table, shellKey
  adapters/     registry.ts, and one directory per adapter (claude-code/)
  analysis/     the timing state machine and aggregates over the model
  conversation/ each transcript's conversation in turns, its findings, and its Markdown export
  report/       the text report
  view/         the view data the viewer reads, its builder, and renderHtml
  viewer/       template.html (markup and CSS) and client/ (the browser TypeScript)
  server/       the loopback HTTP server
  cli/          argument parsing and the commands
test/           cross-layer tests, test/support/ (the test-only memory adapter, fixture paths, runCli), test/fixtures/<adapter>/
eslint/         the repository's own ESLint rules
scripts/        build.ts, parity.ts, expectations.ts
docs/           architecture, model, adapters
```

A layer may import only the layers below; nothing imports `cli/`. The rule `agents-tracer/layers` (`eslint/layers.mjs`, configured in `eslint.config.mjs`) enforces it, along with which Node built-ins each layer may use, that `src/` imports no package (nor `createRequire`), and that a dynamic `import()` names its module by a plain string. When a dependency rule changes, change `eslint.config.mjs` and [docs/architecture.md](docs/architecture.md) together.

| Layer                 | May import                                         | Node built-ins |
| --------------------- | -------------------------------------------------- | -------------- |
| `model`               | nothing                                            | none           |
| `util`                | nothing                                            | `node:path`    |
| `adapters/<id>`       | `model`, `util`                                    | any            |
| `adapters` (registry) | `model`, every adapter                             | none           |
| `analysis`            | `model`, `util`                                    | none           |
| `report`              | `analysis`, `model`, `util`                        | none           |
| `conversation`        | `analysis`, `model`, `util`                        | none           |
| `view`                | `analysis`, `conversation`, `model`, `util`        | any            |
| `viewer/client`       | `view`, with `import type` only                    | none           |
| `server`              | `view`, `adapters` (the registry), `model`, `util` | any            |
| `cli`                 | everything                                         | any            |

Tests (`*.test.ts`, `test/`) may import across layers.

## The adapter boundary

Only `src/adapters/<id>/` knows an agent's transcript format, file layout, or tool names. Everything else reads the neutral model in `src/model/`: a tool call's `desc.category`, never its name (the viewer gets each tool's category in the view data); `Session.shellToolName` to name the shell in the report and the viewer; `Group.kind` to name a group of agents. `eslint/boundaries.mjs` holds each adapter's vocabulary: its `words` (such as `Bash`, `AskUserQuestion`, `TaskStop`, `.claude`, `jsonl`, and record fields such as `toolUseResult`), which no string literal may hold, and its `tools` (every tool name it knows, `Read` and `Agent` included), which no code may match a value against (a comparison, a switch case, a lookup, a membership list, a lookup table's key). Outside `src/adapters/*/` (tests and fixtures excepted), ESLint's `no-restricted-syntax` enforces both in TypeScript, and `test/boundaries.test.ts` checks the words in the other files of `src/`, such as the viewer's template; each adapter's own directory is exempt, since another agent may share a tool's name. A tool name as UI text, such as the `Agent` heading of the viewer's Agents table, is allowed. To add an agent, follow [docs/adapters.md](docs/adapters.md).

## Privacy

The repository is public. Never commit a real transcript, an excerpt of one, a screenshot of a real session, or a real local path, prompt, or command from anyone's sessions. Fixtures are synthetic and hand-written, with fake paths such as `/home/dev/shop` and fake prompts. The same goes for tool names: name no company-internal or private tool in code, tests, or docs. The shell keys build in only widely used public tools (`SUBCOMMAND_TOOLS` in `src/util/shell.ts`); a person's own tools come from `AGENTS_TRACER_SUBCOMMAND_TOOLS`. Read real transcripts only to verify locally, and keep any copies, outputs, and screenshots outside the repository, in a temp directory or the gitignored `local/`.

## Parity with the prototype

The port must behave as the prototype does: for every Claude Code session and subagent transcript, `agents-tracer report` prints byte-identical output to the prototype with the equivalent flags, `agents-tracer list` matches its `--list`, and the view data `agents-tracer html` embeds deep-equals the prototype's (fields may be added, none removed or changed). The viewer renders the same pixels for the same data. The only intended differences are the subcommands instead of flags, the default output location of `html`, and the help and version text, that the tools whose subcommand keys a shell command are only the public ones of `SUBCOMMAND_TOOLS` unless `AGENTS_TRACER_SUBCOMMAND_TOOLS` adds others (`pnpm parity` passes the prototype's whole list that way, read from its source), that the CLI checks option values and reports a bad one in one line where the prototype ran with it (a negative number, a fraction of a count, an exponent, a forgotten value that swallowed the next option), that it prints control characters as visible stand-ins (`pnpm parity` maps the prototype's output the same way), and the conversation, which the prototype has not: the `transcript` command, `html --conversation`, the server's `/s/<id>/conversation`, and the links to it (the served timeline's _Conversation_ link and its detail pane's _Show in the conversation_, the index's _Conversation_ column, the view data's `conversationHref` and span `id`s, and the `#lane=…` hash either page opens at), and `serve --all` and its pages, which the prototype has not either: the projects page at `/` (`ProjectsData`), each project's pages under `/p/<project>`, the redirect of `/s/<id>` to the project that has the session, the index's `projectsHref` and `cwd`, and the view data's `indexHref`, where the served pages link back to their index. Reading a conversation (`LoadOptions.conversation`) leaves a transcript's events as they are, so it cannot change the report or the view data.

Two checks hold the port to it:

- `pnpm test` compares the CLI's `report` and `list` over the synthetic fixtures with the prototype's output for the same files and flags, byte for byte, and the view data its `html` embeds for each fixture transcript with the prototype's (every field equal; fields may be added). The expected outputs are in `test/fixtures/claude-code/expected/` (`cases.json` lists the cases; `view/` holds the view data, without the build time and with the transcript's path relative to the store); `node scripts/expectations.ts` rewrites them by running the prototype, so run it when a fixture or a case changes, and never edit them by hand.
- `pnpm parity [store...]` builds, then compares over real transcripts: for every session and subagent transcript of every store under `~/.claude/projects` (or of the stores given), `report` with and without `--timeline` (and, for a session, with `--turn`, `--top`, `--min-idle`, and `--no-subagents`), `list` per store, and the view data `html` embeds. Transcripts modified in the last 15 minutes are live and skipped. It prints how many it compared and every mismatch with the first differing line, keeps the outputs of mismatches in a temp dir, and exits 1 on any mismatch, and 2 when it cannot compare (no prototype, no build, a `PARITY_JOBS` that is not a whole number from 1) or did not run every comparison. Run it after any change to the adapter, the analysis, the report, or the view; a mismatch is a bug unless the change is deliberate and documented here.

Both scripts find the prototype at `REFERENCE_TRACE`, by default `local/reference/trace.mjs`: link the prototype's `trace.mjs` there (`local/` is gitignored, so no real path is committed). The scripts compare against Claude Code's prototype, so they may name Claude Code's files; the adapter boundary is for `src/`.

## Conventions

- Type safety is a hard requirement: strict TypeScript, no `any`, no type assertions other than `as const`, no non-null assertions, no `@ts-ignore` or `@ts-expect-error`. Parse untrusted JSON into `unknown` and narrow it. Never weaken compiler or lint settings to make code pass.
- No runtime dependencies: Node built-ins only, imported with the `node:` prefix. Dev dependencies are fine.
- ESM throughout; relative imports end in `.js`.
- Code that reads the clock or the time zone formats in local time, as the prototype does; tests run in `Europe/Paris` (`vitest.config.ts`).
- The server binds 127.0.0.1 only, refuses a request addressed to any host but `127.0.0.1`, `localhost`, or `[::1]` (DNS rebinding), and resolves sessions by id, never by a path from the URL.
- The viewer client reaches the DOM through `textContent` and attributes, never `innerHTML`.
- Tests sit next to the code (`*.test.ts`) or under `test/`; fixtures under `test/fixtures/<adapter>/`. Test behavior through each layer's public functions. `test/support/cli.ts`'s `runCli` runs the CLI in process (with any adapter registry) and captures what it prints.
- The report and the CLI print exactly what the prototype prints, quirks included (such as `undefined` for a compaction field the record left out); change the output only together with the prototype's expectations and this document.
- The viewer draws exactly what the prototype draws, quirks included: its breakdown writes `null` for a section a lane lacks (`MISSING` in `src/viewer/client/panels.ts`), and a tool span's tooltip reads the call's output as a token count (`outputTokens` in `src/viewer/client/interact.ts`). To check a viewer change, screenshot the prototype's page and the port's for the same sessions and interactions and compare them pixel by pixel, keeping the screenshots outside the repository.
- The viewer's client tests (`src/viewer/client/*.test.ts`) cover its pure modules and build their data with `test/support/view-data.ts`; what needs the DOM or a canvas is for `test/e2e/`.

## Git

Work on a branch, never on `main` directly. Commit each coherent step with a conventional-commit message (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `build:`). Never push without being asked, never force, and never rewrite `main`.

## Docs

- [Architecture](docs/architecture.md): layers, data flow, how the viewer is built.
- [Model](docs/model.md): the event model and the timing semantics.
- [Adapters](docs/adapters.md): how to add an agent.

Run `pnpm check` before finishing a change, and update the doc that owns a fact in the same change that alters it.
