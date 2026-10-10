import { two } from './format.js';

// Clock times in the local time zone, as the person who ran the session read them.

/**
 * The local time of `ts`, `HH:MM:SS`; with `withDate`, prefixed by the month and day,
 * `MM-DD HH:MM:SS`, for sessions that span days.
 */
export function clock(ts: number, withDate = false): string {
  const d = new Date(ts);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return withDate ? `${two(d.getMonth() + 1)}-${two(d.getDate())} ${time}` : time;
}

/** The local date and time of `ts` to the minute, `YYYY-MM-DD HH:MM`. */
export function day(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** True when `start` and `end` fall on different local days, so clock times need their date. */
export function spansDays(start: number, end: number): boolean {
  return new Date(start).toDateString() !== new Date(end).toDateString();
}
