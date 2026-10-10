import {
  activeOf,
  analyzeSession,
  callSummary,
  MAIN,
  shellBreakdown,
  sumTools,
  usageKnown,
  usageTotals,
  wallOf,
  youOf,
  type SessionAnalysis,
  type TranscriptAnalysis,
} from '../analysis/index.js';
import type { Session, ToolCategory } from '../model/index.js';
import type { ShellKeyOptions } from '../util/index.js';
import type {
  ModelSpan,
  ToolSpan,
  ViewCompaction,
  ViewData,
  ViewGroup,
  ViewLane,
  ViewSpan,
  ViewStats,
} from './types.js';

// The view data of an analyzed session, ported from the prototype's lane and buildView: one lane
// per transcript, the groups they sit in, and what the client needs to read tools by category.

/** The id of the group of agents that ran on their own, and its label. */
const AGENTS_GROUP = 'agents';

/** Keeps the head and the tail of a long text: a command's failures are usually at its end. */
export function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  const head = Math.ceil(n / 2);
  const tail = n - head;
  return `${text.slice(0, head)}\n\n… ${text.length - n} characters left out …\n\n${text.slice(text.length - tail)}`;
}

/** A number as JSON writes it: null for NaN and the infinities. */
function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/** What sets a lane apart: the main transcript's or an agent's. */
type LaneInfo =
  | { readonly label: string; readonly group: string; readonly parent: null }
  | {
      readonly label: string;
      readonly phase: string | null;
      readonly agentType: string | null;
      readonly background: boolean;
      readonly group: string;
      readonly parent: string | null;
      readonly nested: boolean;
    };

/** One lane: a transcript's state track, its model and tool spans, its turns, and its stats. */
function lane(id: string, a: TranscriptAnalysis, info: LaneInfo, shell: ShellKeyOptions): ViewLane {
  const known = usageKnown(a.calls);
  const spans: ViewSpan[] = [];
  const toolIndex = new Map<string, number>();
  for (const tc of a.tools) {
    toolIndex.set(tc.id, spans.length);
    const span: ToolSpan = {
      t: 't',
      s: tc.start,
      e: tc.end ?? tc.start,
      ms: tc.ms ?? null,
      name: tc.name,
      pv: tc.desc.preview,
      desc: tc.desc.purpose ?? '',
      in: clip(tc.desc.inputText, 3000),
      out: clip(tc.output, 2000),
      err: tc.isError,
      intr: tc.interrupted,
      async: tc.async,
      bgEnd: tc.bgEnd ?? null,
      agent: tc.launches.agentId ?? null,
      run: tc.launches.groupId ?? null,
      turn: tc.turn?.n ?? null,
      cat: tc.desc.category,
    };
    spans.push(span);
  }
  const callTools = new Map<number, readonly string[]>(); // a model span's index -> its tool call ids
  for (const c of a.calls) {
    const u = c.usage;
    callTools.set(
      spans.length,
      c.tools.map((t) => t.id),
    );
    const span: ModelSpan = {
      t: 'm',
      s: c.start,
      e: c.end,
      ms: c.ms,
      ...(c.model !== undefined && { model: c.model }),
      syn: c.synthetic,
      out: known ? (u?.output ?? 0) : null,
      cr: known ? (u?.cacheRead ?? 0) : null,
      cw: known ? (u?.cacheWrite ?? 0) : null,
      stop: c.stop,
      think: c.blocks.some((b) => b === 'thinking' || b === 'redacted_thinking'),
      text: clip(c.text, 4000),
      tools: [],
      sum: callSummary(c),
      turn: c.turn?.n ?? null,
    };
    spans.push(span);
  }
  // By start, a model span first; then the model spans' tool ids become span indexes. The order is
  // the prototype's comparator's, on the same input, so equal starts land where they land there.
  const order = spans
    .map((span, i) => ({ span, i }))
    .sort((x, y) => x.span.s - y.span.s || (x.span.t === 'm' ? -1 : 1));
  const newIndex = new Map(order.map(({ i }, at) => [i, at]));
  const sorted = order.map(({ span, i }): ViewSpan => {
    if (span.t === 't') return span;
    const tools: number[] = [];
    for (const toolId of callTools.get(i) ?? []) {
      const old = toolIndex.get(toolId);
      const at = old === undefined ? undefined : newIndex.get(old);
      if (at !== undefined) tools.push(at);
    }
    return { ...span, tools };
  });

  const u = usageTotals(a.calls);
  const stats: ViewStats = {
    wall: finite(wallOf(a)),
    active: activeOf(a.buckets),
    model: a.buckets.get('model') ?? 0,
    tools: sumTools(a.buckets),
    you: youOf(a.buckets),
    calls: a.calls.length,
    toolCalls: a.tools.length,
    out: known ? u.output : null,
    cacheRead: known ? u.cacheRead : null,
    cacheWrite: known ? u.cacheWrite : null,
    models: [...a.models],
    compactions: a.transcript.compactions.map((c): ViewCompaction => ({
      ...(c.preTokens !== undefined && { pre: c.preTokens }),
      ...(c.postTokens !== undefined && { post: c.postTokens }),
      ...(c.durationMs !== undefined && { ms: c.durationMs }),
      ...(c.trigger !== undefined && { trigger: c.trigger }),
    })),
  };
  return {
    id,
    ...info,
    ...(a.start !== undefined && { start: a.start }),
    ...(a.end !== undefined && { end: a.end }),
    title: a.transcript.title ?? null,
    seg: a.segments,
    spans: sorted,
    turns: a.turns.map((t) => ({
      n: t.n,
      ts: t.ts,
      end: t.end,
      kind: t.kind,
      text: clip(t.text, 8000),
      calls: t.calls,
      tools: t.tools,
      b: [...t.buckets],
    })),
    buckets: [...a.buckets].sort((x, y) => y[1] - x[1]),
    bash: shellBreakdown(a.tools, shell).map((r) => [r.key, r.ms, r.calls, r.max, r.failed] as const),
    stats,
  };
}

/** How to build the view data. */
export interface ViewOptions {
  /** The page is served, so it links back to the index. */
  readonly serve?: boolean;
  /** The build time, epoch milliseconds; now by default. */
  readonly now?: number;
  /** More tools whose subcommand is part of a shell command's key (util's `shellKey`). */
  readonly subcommandTools?: readonly string[];
}

/**
 * The view data of an analyzed session: the main transcript's lane, then each agent's by start,
 * with the groups they sit in (the session, the agents on their own, and each group of agents).
 */
export function buildView(analysis: SessionAnalysis, options: ViewOptions = {}): ViewData {
  const { session, main } = analysis;
  const lanes: ViewLane[] = [lane(MAIN, main, { label: 'Main session', group: MAIN, parent: null }, options)];
  // Sorted with their starts as numbers, NaN for a lane without events, as the prototype's are.
  const groups: { group: ViewGroup; start: number }[] = [{ group: { id: MAIN, label: 'Session' }, start: NaN }];

  const agents = analysis.agents;
  const startOf = (a: TranscriptAnalysis): number => a.start ?? NaN;
  const groupStart = new Map<string, number>();
  for (const { agent, analysis: a } of agents)
    if (agent.group !== null)
      groupStart.set(agent.group, Math.min(groupStart.get(agent.group) ?? Infinity, startOf(a)));
  const loose = agents.filter(({ agent }) => agent.group === null);
  if (loose.length) {
    const start = Math.min(...loose.map(({ analysis: a }) => startOf(a)));
    groups.push({ group: { id: AGENTS_GROUP, label: 'Agents', start: finite(start) }, start });
  }
  for (const [id, start] of groupStart) {
    const g = session.groups.find((x) => x.id === id);
    groups.push({
      group: {
        id,
        label: g?.label ?? id,
        status: g?.status ?? null,
        ms: g?.durationMs ?? null,
        tokens: g?.totalTokens ?? null,
        toolCalls: g?.totalToolCalls ?? null,
        start: finite(start),
        ...(g !== undefined && { kind: g.kind }),
      },
      start,
    });
  }
  groups.sort((x, y) => (x.group.id === MAIN ? -1 : y.group.id === MAIN ? 1 : x.start - y.start));

  for (const { agent, analysis: a, parent, nested } of [...agents].sort(
    (x, y) => startOf(x.analysis) - startOf(y.analysis),
  ))
    lanes.push(
      lane(
        agent.id,
        a,
        {
          label: agent.description ?? agent.id,
          phase: agent.phase ?? null,
          agentType: agent.agentType ?? null,
          background: agent.background,
          group: agent.group ?? AGENTS_GROUP,
          parent,
          nested,
        },
        options,
      ),
    );

  const categories = new Map<string, ToolCategory>();
  for (const a of [main, ...agents.map((x) => x.analysis)])
    for (const t of a.tools) if (!categories.has(t.name)) categories.set(t.name, t.desc.category);
  // fromEntries defines own properties, so that a tool named __proto__ is a key like any other.
  const toolCategories: Record<string, ToolCategory> = Object.fromEntries(categories);

  return {
    session: {
      id: main.transcript.id,
      title: main.transcript.title ?? null,
      cwd: main.transcript.cwd ?? null,
      file: main.transcript.path,
    },
    groups: groups.map((g) => g.group),
    lanes,
    generated: options.now ?? Date.now(),
    ...(options.serve === true && { serve: true }),
    toolCategories,
    shellLabel: session.shellToolName ?? 'Shell',
  };
}

/** The view data of a session: its analysis, built into lanes (see {@link buildView}). */
export function viewSession(session: Session, options: ViewOptions = {}): ViewData {
  return buildView(analyzeSession(session), options);
}
