// Narrowing parsed JSON, which arrives as `unknown`, without type assertions.

/** True for a JSON object: not `null`, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` when it is a string, else `undefined`. */
export function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `value` when it is a number, else `undefined`. */
export function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * A parsed JSON value as JavaScript's `String(value)` writes it: `undefined` and `null` by name,
 * an array as its elements joined by commas (a missing element empty), an object as
 * `[object Object]`. Code ported from JavaScript converts loosely typed input with it to keep that
 * code's output.
 */
export function jsText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v: unknown) => (v == null ? '' : jsText(v))).join(',');
  if (typeof value === 'object' && value !== null) return '[object Object]';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value === null) return 'null';
  return 'undefined';
}

/** `value` as JavaScript's `String(value ?? '')` writes it: `null` and `undefined` are empty. */
export function looseText(value: unknown): string {
  return value == null ? '' : jsText(value);
}

/**
 * The values of JSON lines: one per non-empty line that parses. Lines that do not parse are
 * skipped, since a file still being written can end in a partial line.
 */
export function parseJsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      out.push(value);
    } catch {
      // a partial line
    }
  }
  return out;
}
