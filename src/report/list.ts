import type { SessionSummary } from '../model/index.js';
import { day, fmt, oneLine, table, type TableCell } from '../util/index.js';

// The sessions of a store, one line each. Ported from the prototype's list().

/** The table of `sessions`, in their order: short id, start, wall time, size, and title or first prompt. */
export function sessionList(sessions: readonly SessionSummary[]): string {
  return table(
    [
      ['session', 'start', 'wall', 'size', 'title / first prompt'],
      ...sessions.map((s): TableCell[] => [
        s.id.slice(0, 8),
        day(s.start),
        fmt(s.end - s.start),
        `${Math.round(s.size / 1024)}K`,
        oneLine(s.title ?? s.firstPrompt, 80),
      ]),
    ],
    ['l', 'l', 'r', 'r'],
  );
}
