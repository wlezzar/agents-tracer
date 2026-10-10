import type { Usage } from '../model/index.js';
import { fmt, oneLine, shellKey, type ShellKeyOptions } from '../util/index.js';
import type { Bucket, IdleBucket, ModelCall, ShellRow, ToolLike, ToolRun, TranscriptAnalysis } from './types.js';

// Aggregates over an analysis that the report and the view share, ported from the prototype's
// activeOf, sumTools, usageKnown, usageTotals, topTools, bashTable, and callSummary.

/** True for the idle buckets, whose time is not active. */
export function isIdle(bucket: Bucket): bucket is IdleBucket {
  return bucket.startsWith('idle');
}

/** The bucket a pending tool call's time goes to: the person's for a question, else the tool's. */
export function bucketOf(tool: ToolLike | undefined): Bucket {
  if (!tool) return 'tool:?';
  return tool.desc.category === 'question' ? 'you: answering questions' : `tool:${tool.name}`;
}

function sum(buckets: ReadonlyMap<Bucket, number>, keep: (bucket: Bucket) => boolean): number {
  let total = 0;
  for (const [bucket, ms] of buckets) if (keep(bucket)) total += ms;
  return total;
}

/** Active time: every bucket but the idle ones. */
export function activeOf(buckets: ReadonlyMap<Bucket, number>): number {
  return sum(buckets, (b) => !isIdle(b));
}

/** Tool time: the `tool:` buckets (not the person's answering questions). */
export function sumTools(buckets: ReadonlyMap<Bucket, number>): number {
  return sum(buckets, (b) => b.startsWith('tool:'));
}

/**
 * The person's time: waiting on them (with or without background tasks running) and their
 * answering questions.
 */
export function youOf(buckets: ReadonlyMap<Bucket, number>): number {
  return sum(
    buckets,
    (b) =>
      b === 'idle: waiting on you' || b.startsWith('you:') || b === 'idle: waiting on you, background tasks running',
  );
}

/** Wall time from the first event to the last; NaN for a transcript without events. */
export function wallOf(analysis: Pick<TranscriptAnalysis, 'start' | 'end'>): number {
  const { start, end } = analysis;
  return start === undefined || end === undefined ? NaN : end - start;
}

/**
 * Whether the transcript's token counts are known: at least 90% of its calls have a stop reason.
 * Subagent transcripts are written mid-stream: no stop reason, and usage counts only what had
 * streamed so far, so their counts are unknown rather than small.
 */
export function usageKnown(calls: readonly ModelCall[]): boolean {
  return calls.length > 0 && calls.filter((c) => c.stop != null).length >= 0.9 * calls.length;
}

/** The calls' token counts summed; a call without usage counts 0. */
export function usageTotals(calls: readonly ModelCall[]): Usage {
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let input = 0;
  for (const c of calls) {
    output += c.usage?.output ?? 0;
    cacheRead += c.usage?.cacheRead ?? 0;
    cacheWrite += c.usage?.cacheWrite ?? 0;
    input += c.usage?.input ?? 0;
  }
  return { output, cacheRead, cacheWrite, input };
}

/**
 * The `n` largest tool buckets and the person's answering questions, as `Read 4.0s, you: answering
 * questions 12s` (tool buckets without their `tool:` prefix).
 */
export function topTools(buckets: ReadonlyMap<Bucket, number>, n = 3): string {
  return [...buckets]
    .filter(([k]) => k.startsWith('tool:') || k.startsWith('you:'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k.replace(/^tool:/, '')} ${fmt(v)}`)
    .join(', ');
}

/**
 * The shell calls that have a result, grouped by command key (`shellKey` of the command with
 * `options`, and ` [bg]` for background ones), the largest sum of durations first; ties keep
 * first-seen order.
 */
export function shellBreakdown(tools: readonly ToolRun[], options: ShellKeyOptions = {}): ShellRow[] {
  const groups = new Map<string, { key: string; ms: number; calls: number; max: number; failed: number }>();
  for (const t of tools) {
    if (t.desc.category !== 'shell' || t.ms == null) continue;
    const key = shellKey(t.desc.shellCommand, options) + (t.desc.runsInBackground ? ' [bg]' : '');
    const row = groups.get(key) ?? { key, ms: 0, calls: 0, max: 0, failed: 0 };
    row.ms += t.ms;
    row.calls++;
    row.max = Math.max(row.max, t.ms);
    if (t.isError) row.failed++;
    groups.set(key, row);
  }
  return [...groups.values()].sort((x, y) => y.ms - x.ms);
}

/**
 * One line that says what a model call did: `[synthetic]`, `thinking`, its tool calls by name
 * (`Read src/cart.ts`, or `Read ×3`), and its text.
 */
export function callSummary(call: ModelCall): string {
  const parts: string[] = [];
  const thinking = call.blocks.filter((b) => b === 'thinking' || b === 'redacted_thinking').length;
  if (thinking) parts.push('thinking');
  const byName = new Map<string, ToolRun[]>();
  for (const t of call.tools) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  for (const [name, list] of byName) {
    const [first] = list;
    parts.push(list.length > 1 || !first ? `${name} ×${list.length}` : `${name} ${oneLine(first.desc.preview, 50)}`);
  }
  if (call.text) parts.push(`“${oneLine(call.text, 60)}”`);
  if (call.synthetic) parts.unshift('[synthetic]');
  return parts.join(' · ');
}
