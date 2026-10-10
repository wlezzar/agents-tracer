import type { SessionAnalysis } from '../analysis/index.js';
import { reportContext, type ReportOptions } from './context.js';
import { subagentReport } from './subagents.js';
import { summary } from './summary.js';
import { timeline } from './timeline.js';

// The text report, ported from the prototype so that its output is byte for byte the same. Every
// function returns text; the CLI prints it.

export { reportContext, type ReportContext, type ReportOptions } from './context.js';
export { sessionList } from './list.js';
export { subagentReport } from './subagents.js';
export { summary } from './summary.js';
export { timeline } from './timeline.js';

/**
 * The report on an analyzed session, as the CLI prints it (without the final newline): the main
 * transcript's summary, then its subagents (unless `options.subagents` is false, or there are
 * none), then, with `options.timeline`, its timeline. The shell breakdown is titled with the
 * session's `shellToolName`, `Shell` when it has none.
 */
export function report(s: SessionAnalysis, options: ReportOptions = {}): string {
  const ctx = reportContext(s.main, options);
  const parts = [summary(s.main, s.session.shellToolName ?? 'Shell', ctx)];
  if (options.subagents ?? true) {
    const agents = subagentReport(s, ctx);
    if (agents) parts.push(agents);
  }
  if (options.timeline) parts.push(timeline(s.main, ctx, options.turn));
  return parts.join('\n');
}
