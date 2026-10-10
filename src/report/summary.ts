import {
  activeOf,
  bucketOf,
  callSummary,
  isIdle,
  shellBreakdown,
  sumTools,
  topTools,
  usageKnown,
  usageTotals,
  wallOf,
  type Bucket,
  type TranscriptAnalysis,
} from '../analysis/index.js';
import type { Compaction } from '../model/index.js';
import { day, fmt, indent, jsText, kTok, oneLine, pct, table, type TableCell } from '../util/index.js';
import { at, outTokens, type ReportContext } from './context.js';

// The summary of one transcript: its header, where the time went, the shell breakdown, the slowest
// tool calls and model responses, and its turns. Ported from the prototype's summary().

/**
 * A compaction's token count. A count the record left out prints as `undefined`, as the
 * prototype's `kTok(undefined)` did; the compactions agents record have all four fields.
 */
function compactionTokens(n: number | undefined): string {
  return n === undefined ? jsText(n) : kTok(n);
}

function compactionText(c: Compaction): string {
  return `${compactionTokens(c.preTokens)}→${compactionTokens(c.postTokens)} in ${fmt(c.durationMs)} (${jsText(c.trigger)})`;
}

/**
 * The summary of `a`. `shellLabel` names the shell tool in the shell breakdown's title, such as
 * `Bash by command`.
 */
export function summary(a: TranscriptAnalysis, shellLabel: string, ctx: ReportContext): string {
  const { transcript } = a;
  const lines: string[] = [];
  const active = activeOf(a.buckets);
  const u = usageTotals(a.calls);
  lines.push(`${transcript.id}${transcript.title ? `  “${transcript.title}”` : ''}`);
  lines.push(`  ${day(a.start ?? NaN)} → ${day(a.end ?? NaN)}  ·  ${fmt(wallOf(a))} wall  ·  ${fmt(active)} active`);
  lines.push(
    `  ${a.calls.length} API calls (${a.models.join(', ') || 'no model'})  ·  ${a.tools.length} tool calls  ·  ` +
      (usageKnown(a.calls)
        ? `${kTok(u.output)} output, ${kTok(u.cacheRead)} cache-read, ${kTok(u.cacheWrite)} cache-write, ${kTok(u.input)} uncached input tokens`
        : 'tokens not recorded (subagent transcript)'),
  );
  if (transcript.compactions.length)
    lines.push(
      `  ${transcript.compactions.length} compactions: ${transcript.compactions.map(compactionText).join(', ')}`,
    );

  // Where the time went: active buckets first, each with its share of the active time and its count.
  const counts = new Map<Bucket, number>();
  if (a.calls.length) counts.set('model', a.calls.length);
  for (const t of a.tools) {
    const bucket = bucketOf(t);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const sorted = [...a.buckets].sort((x, y) => y[1] - x[1]);
  const activeRows = sorted.filter(([k]) => !isIdle(k));
  const idleRows = sorted.filter(([k]) => isIdle(k));
  lines.push('', 'Where the time went');
  lines.push(
    indent(
      table(
        [
          ['', 'time', 'active', 'count'],
          ...activeRows.map(([k, v]): TableCell[] => [k, fmt(v), pct(v, active), counts.get(k) ?? '']),
          ...idleRows.map(([k, v]): TableCell[] => [k, fmt(v), '', '']),
        ],
        ['l', 'r', 'r', 'r'],
      ),
    ),
  );

  // The shell calls by command. The title is printed whenever there are any, even when `top` is 0.
  const shell = shellBreakdown(a.tools, ctx.shell);
  if (shell.length) {
    lines.push('', `${shellLabel} by command (sum of call durations)`);
    lines.push(
      indent(
        table(
          [
            ['', 'time', 'calls', 'max', 'failed'],
            ...shell.slice(0, ctx.top).map((r): TableCell[] => [r.key, fmt(r.ms), r.calls, fmt(r.max), r.failed || '']),
          ],
          ['l', 'r', 'r', 'r', 'r'],
        ),
      ),
    );
  }

  const slow = a.tools
    .flatMap((t) => (t.ms == null ? [] : [{ t, ms: t.ms }]))
    .sort((x, y) => y.ms - x.ms)
    .slice(0, ctx.top);
  if (slow.length) {
    lines.push('', 'Slowest tool calls');
    lines.push(
      indent(
        table(
          slow.map(({ t, ms }): TableCell[] => [
            `#${t.turn?.n ?? '-'}`,
            at(ctx, t.start),
            fmt(ms),
            t.name,
            `${t.desc.preview}${t.isError ? '  ✗' : ''}`,
          ]),
          ['r', 'l', 'r', 'l'],
        ),
      ),
    );
  }

  const slowCalls = a.calls
    .filter((c) => !c.synthetic)
    .sort((x, y) => y.ms - x.ms)
    .slice(0, ctx.top);
  if (slowCalls.length) {
    lines.push('', 'Slowest model responses');
    lines.push(
      indent(
        table(
          slowCalls.map((c): TableCell[] => [
            `#${c.turn?.n ?? '-'}`,
            at(ctx, c.ts),
            fmt(c.ms),
            outTokens(ctx, c),
            callSummary(c),
          ]),
          ['r', 'l', 'r', 'r'],
        ),
      ),
    );
  }

  if (a.turns.length) {
    lines.push('', 'Turns (active time only; idle time is between turns)');
    const rows = a.turns.map((t): TableCell[] => [
      `#${t.n}`,
      at(ctx, t.ts),
      t.kind,
      fmt(activeOf(t.buckets)),
      fmt(t.buckets.get('model') ?? 0),
      fmt(sumTools(t.buckets)),
      t.calls,
      t.tools,
      topTools(t.buckets, 2),
      oneLine(t.text, 60),
    ]);
    lines.push(
      indent(
        table(
          [['', 'start', 'by', 'active', 'model', 'tools', 'calls', 'tools#', 'top tools', 'prompt'], ...rows],
          ['r', 'l', 'l', 'r', 'r', 'r', 'r', 'r'],
        ),
      ),
    );
  }
  return lines.join('\n');
}
