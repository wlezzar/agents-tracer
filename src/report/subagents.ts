import {
  sumTools,
  topTools,
  usageKnown,
  usageTotals,
  wallOf,
  type AgentAnalysis,
  type SessionAnalysis,
} from '../analysis/index.js';
import { fmt, indent, kTok, oneLine, table, type Align, type TableCell } from '../util/index.js';
import { at, type ReportContext } from './context.js';

// The session's subagents: those on their own in one table, then each group of agents (such as a
// workflow run) under a header of its kind, name, id, and summary. Ported from the prototype's
// subagentReport().

const header: readonly TableCell[] = ['start', 'wall', 'model', 'tools', 'calls', 'out', 'top tools', 'agent'];
const align: readonly Align[] = ['l', 'r', 'r', 'r', 'r', 'r'];

const byStart = (x: AgentAnalysis, y: AgentAnalysis): number => (x.analysis.start ?? NaN) - (y.analysis.start ?? NaN);

/** The earliest start of the agents; NaN when any has no events, as `Math.min` gives it. */
const firstStart = (agents: readonly AgentAnalysis[]): number =>
  Math.min(...agents.map((x) => x.analysis.start ?? NaN));

function row(ctx: ReportContext, { analysis: a }: AgentAnalysis, label: string): TableCell[] {
  return [
    at(ctx, a.start),
    fmt(wallOf(a)),
    fmt(a.buckets.get('model') ?? 0),
    fmt(sumTools(a.buckets)),
    a.calls.length,
    usageKnown(a.calls) ? kTok(usageTotals(a.calls).output) : '-',
    topTools(a.buckets),
    label,
  ];
}

/** The subagents' report of `s`, starting with an empty line; empty when the session has no agents. */
export function subagentReport(s: SessionAnalysis, ctx: ReportContext): string {
  if (s.agents.length === 0) return '';
  const lines = ['', 'Subagents (they run alongside the session, so their time overlaps it)'];

  const loose = s.agents.filter((x) => x.agent.group === null).sort(byStart);
  if (loose.length) {
    const rows = loose.map((x) => {
      const { agent, launcher } = x;
      const how = launcher?.async || agent.background ? 'background' : 'foreground';
      return row(ctx, x, `${agent.description ?? launcher?.desc.preview ?? ''} [${how}, ${agent.id.slice(0, 9)}]`);
    });
    lines.push(indent(table([header, ...rows], align)));
  }

  const byGroup = new Map<string, AgentAnalysis[]>();
  for (const x of s.agents) {
    const { group } = x.agent;
    if (group === null) continue;
    const list = byGroup.get(group) ?? [];
    list.push(x);
    byGroup.set(group, list);
  }
  for (const [id, list] of [...byGroup].sort((x, y) => firstStart(x[1]) - firstStart(y[1]))) {
    const group = s.session.groups.find((g) => g.id === id);
    const tokens = group?.totalTokens != null ? ` · ${kTok(group.totalTokens)} tokens` : '';
    lines.push('');
    lines.push(
      `  ${group?.kind ?? 'Group'} ${group?.name ?? '?'} ${id} · ${group?.status ?? '?'} · ${fmt(group?.durationMs)} · ${list.length} agents${tokens}`,
    );
    list.sort(byStart);
    const rows = list.map((x) => {
      const { phase, description, id: agentId } = x.agent;
      return row(ctx, x, `${phase ? `${phase}: ` : ''}${oneLine(description, 60)} [${agentId.slice(0, 9)}]`);
    });
    lines.push(indent(table([header, ...rows], align), 4));
  }
  return lines.join('\n');
}
