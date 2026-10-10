import { callSummary, type TranscriptAnalysis } from '../analysis/index.js';
import { fmt, oneLine } from '../util/index.js';
import { at, outTokens, type ReportContext } from './context.js';

// The timeline of a transcript: each turn as a heading, then its model calls, tool calls, idle
// gaps, and interrupts, one line each, in order. Ported from the prototype's timeline().

/** The timeline of `a`, every turn or only `turn`, starting with an empty line before the first turn. */
export function timeline(a: TranscriptAnalysis, ctx: ReportContext, turn?: number): string {
  const lines: string[] = [];
  let show = turn === undefined;
  for (const item of a.timeline) {
    if (item.kind === 'turn') {
      const t = item.turn;
      show = turn === undefined || t.n === turn;
      if (show) lines.push('', `── #${t.n} ${at(ctx, t.ts)} ${t.kind}: ${oneLine(t.text, 100)}`);
      continue;
    }
    if (!show) continue;
    switch (item.kind) {
      case 'call': {
        const c = item.call;
        lines.push(
          `${at(ctx, c.end)}  ${fmt(c.ms).padStart(6)}  ${'model'.padEnd(10)} ${outTokens(ctx, c).padStart(9)}  ${callSummary(c)}`,
        );
        break;
      }
      case 'tool': {
        const t = item.tool;
        const flag = t.isError ? '  ✗' : t.async ? '  [async]' : '';
        lines.push(
          `${at(ctx, t.end)}  ${fmt(t.ms).padStart(6)}  ${t.name.padEnd(10)} ${oneLine(t.desc.preview, 90)}${flag}`,
        );
        break;
      }
      case 'idle':
        lines.push(`${at(ctx, item.ts)}  ${fmt(item.gap).padStart(6)}  … ${item.bucket.replace(/^idle: /, '')}`);
        break;
      case 'interrupt':
        lines.push(`${at(ctx, item.ts)}          ⏹ interrupted`);
        break;
    }
  }
  return lines.join('\n');
}
