import { usageKnown, type ModelCall, type TranscriptAnalysis } from '../analysis/index.js';
import { clock, kTok, spansDays, type ShellKeyOptions } from '../util/index.js';

// What every part of a session's report shares: how clock times are written, whether token counts
// are shown, and how many rows a "slowest" table holds. The main transcript decides the first two,
// as the prototype's module-level `multiDay` and `showTokens` did.

/** How the report reads; every field has a default. */
export interface ReportOptions {
  /** The rows of the shell breakdown and of the slowest tool calls and model responses; 10 by default. */
  readonly top?: number;
  /** Add the timeline of the main transcript; false by default. */
  readonly timeline?: boolean;
  /** Show only this turn (numbered from 1) of the timeline; every turn by default. */
  readonly turn?: number;
  /** Add the subagents' table; true by default. */
  readonly subagents?: boolean;
  /** More tools whose subcommand is part of a shell command's key (util's `shellKey`). */
  readonly subcommandTools?: readonly string[];
}

/** The report's settings, decided once from the main transcript and the options. */
export interface ReportContext {
  /** The main transcript spans local days, so clock times carry their date. */
  readonly withDate: boolean;
  /** The main transcript's token counts are known (`usageKnown`), so model calls show theirs. */
  readonly showTokens: boolean;
  readonly top: number;
  /** How the shell breakdown keys commands. */
  readonly shell: ShellKeyOptions;
}

/** The context of a report on the session whose main transcript is `main`. */
export function reportContext(main: TranscriptAnalysis, options: ReportOptions = {}): ReportContext {
  return {
    withDate: spansDays(main.start ?? NaN, main.end ?? NaN),
    showTokens: usageKnown(main.calls),
    top: options.top ?? 10,
    shell: options,
  };
}

/** The clock time of `ts`; a missing time prints as the prototype's invalid date, `NaN:NaN:NaN`. */
export function at(ctx: ReportContext, ts: number | undefined): string {
  return clock(ts ?? NaN, ctx.withDate);
}

/** A model call's output tokens, `420 out`, when the report shows tokens and the call has a stop reason. */
export function outTokens(ctx: ReportContext, call: ModelCall): string {
  return ctx.showTokens && call.stop != null ? `${kTok(call.usage?.output ?? 0)} out` : '';
}
