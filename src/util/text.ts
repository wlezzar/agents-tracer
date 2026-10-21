// Plain-text layout for the report: one-line excerpts, aligned tables, indentation, and text safe
// for a terminal.

/**
 * `s` on one line, its runs of whitespace collapsed to one space and trimmed, cut to `n`
 * characters with a trailing ellipsis. A missing value is the empty string.
 */
export function oneLine(s: string | null | undefined, n = 80): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Keeps the head and the tail of a long text, `n` characters in all: a command's failures are usually at its end. */
export function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  const head = Math.ceil(n / 2);
  const tail = n - head;
  return `${text.slice(0, head)}\n\n… ${text.length - n} characters left out …\n\n${text.slice(text.length - tail)}`;
}

/** A table cell; a missing one prints as nothing. */
export type TableCell = string | number | null | undefined;

/** How a column aligns: `l` pads on the right, `r` on the left. */
export type Align = 'l' | 'r';

/**
 * Rows as aligned columns, two spaces apart. Every column but the last is padded to its widest
 * cell, which the first row's length decides; columns align left unless `align` says `r`. Each
 * line's trailing spaces are trimmed. No rows make the empty string.
 */
export function table(rows: readonly (readonly TableCell[])[], align: readonly Align[] = []): string {
  const first = rows[0];
  if (first === undefined) return '';
  const widths = first.map((_, c) => Math.max(...rows.map((r) => cellText(r[c]).length)));
  return rows
    .map((r) =>
      r
        .map((cell, c) => {
          const s = cellText(cell);
          if (c === r.length - 1) return s;
          const width = widths[c] ?? 0;
          return align[c] === 'r' ? s.padStart(width) : s.padEnd(width);
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function cellText(cell: TableCell): string {
  return String(cell ?? '');
}

/** `s` with every non-empty line indented by `n` spaces. */
export function indent(s: string, n = 2): string {
  return s.replace(/^(?=.)/gm, ' '.repeat(n));
}

/**
 * `text` safe to write to a terminal: every control character but a newline or a tab, which could
 * start an escape sequence that moves the cursor, retitles the window, or clears the screen, becomes
 * a visible stand-in of the same length: its control picture (`␛` for ESC, `␡` for DEL), or `�` for
 * the C1 controls, which have none.
 */
export function printable(text: string): string {
  return text.replace(/\p{Cc}/gu, (c) => {
    if (c === '\n' || c === '\t') return c;
    const code = c.charCodeAt(0);
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '\u2421' : '\ufffd';
  });
}
