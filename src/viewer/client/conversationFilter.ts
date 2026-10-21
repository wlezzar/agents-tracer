import type { ConversationBlock, ConversationItem, ConversationTurn, ModelItem, ToolBlock } from '../../view/types.js';

// What the conversation page shows of a thread: the filter, the search, and whether the harness's
// context is shown decide, for each part of a turn, whether it is shown. A model call is shown when
// any of its blocks is; a turn when any of its parts is.

/** What the filter keeps. */
export type ConversationFilter = 'all' | 'dialogue' | 'tools' | 'shell' | 'failed' | 'harness' | 'thinking' | 'slow';

export const FILTERS: readonly ConversationFilter[] = [
  'all',
  'dialogue',
  'tools',
  'shell',
  'failed',
  'harness',
  'thinking',
  'slow',
];

export function isFilter(value: string): value is ConversationFilter {
  return FILTERS.some((f) => f === value);
}

/** What decides what is shown. */
export interface FilterState {
  readonly filter: ConversationFilter;
  /** The search, lower case; empty for none. */
  readonly query: string;
  /** Whether the harness's context is shown when the filter does not ask for it. */
  readonly harness: boolean;
}

/** A tool call or model call slower than this is slow. */
export const SLOW_MS = 10_000;

/** A tool call that failed, was interrupted, or was refused. */
export function isFailure(b: ToolBlock): boolean {
  return b.status === 'error' || b.status === 'interrupted' || b.permission?.allowed === false;
}

/** The text a search looks in, lower case and kept, since a thread's outputs can be long. */
const lowered = new WeakMap<object, string>();
function haystack(part: object, text: () => string): string {
  let s = lowered.get(part);
  if (s === undefined) {
    s = text().toLowerCase();
    lowered.set(part, s);
  }
  return s;
}

/** The text of a block that a search looks in. */
export function blockText(b: ConversationBlock): string {
  switch (b.type) {
    case 'tool':
      return `${b.name}\n${b.preview}\n${b.purpose}\n${b.input}\n${b.output}`;
    case 'other':
      return `${b.label}\n${b.text}`;
    case 'thinking':
    case 'text':
      return b.text;
  }
}

/** The text of an item other than a model call that a search looks in. */
export function itemText(item: Exclude<ConversationItem, ModelItem>): string {
  switch (item.type) {
    case 'prompt':
      return item.text;
    case 'context':
      return `${item.label}\n${item.text}`;
    case 'compaction':
      return item.summary;
    case 'notice':
      return item.text;
    case 'result':
      return item.output;
  }
}

/** Whether the search finds `text` (lower case); true without a search. */
function found(state: FilterState, part: object, text: () => string): boolean {
  return !state.query || haystack(part, text).includes(state.query);
}

/** Whether a model call's block is shown. */
export function blockShown(b: ConversationBlock, model: ModelItem, state: FilterState): boolean {
  if (!found(state, b, () => blockText(b))) return false;
  switch (state.filter) {
    case 'all':
      return true;
    case 'dialogue':
      return b.type === 'text';
    case 'tools':
      return b.type === 'tool';
    case 'shell':
      return b.type === 'tool' && b.category === 'shell';
    case 'failed':
      return (b.type === 'tool' && isFailure(b)) || (model.error && b.type === 'text');
    case 'harness':
      return false;
    case 'thinking':
      return b.type === 'thinking' && b.text !== '';
    case 'slow':
      return b.type === 'tool' ? (b.ms ?? 0) >= SLOW_MS : b.type === 'text' && model.ms >= SLOW_MS;
  }
}

/** Whether an item is shown: a model call when any of its blocks is. */
export function itemShown(item: ConversationItem, state: FilterState): boolean {
  if (item.type === 'model') return item.blocks.some((b) => blockShown(b, item, state));
  if (!found(state, item, () => itemText(item))) return false;
  switch (state.filter) {
    case 'all':
      return item.type !== 'context' || state.harness;
    case 'dialogue':
      return item.type === 'prompt';
    case 'harness':
      return item.type === 'context';
    case 'failed':
      return (item.type === 'notice' && item.level !== 'info') || (item.type === 'result' && item.status !== 'ok');
    case 'tools':
    case 'shell':
    case 'thinking':
    case 'slow':
      return false;
  }
}

/** Whether any part of a turn is shown. */
export function turnShown(turn: ConversationTurn, state: FilterState): boolean {
  return turn.items.some((i) => itemShown(i, state));
}

/** Whether nothing is filtered out: every part of every turn shows, harness included. */
export function showsAll(state: FilterState): boolean {
  return state.filter === 'all' && !state.query && state.harness;
}

/** The tool calls of a turn, and how many of them failed, were interrupted, or were refused. */
export function turnTools(turn: ConversationTurn): { readonly calls: number; readonly failures: number } {
  let calls = 0;
  let failures = 0;
  for (const i of turn.items)
    if (i.type === 'model')
      for (const b of i.blocks)
        if (b.type === 'tool') {
          calls++;
          if (isFailure(b)) failures++;
        }
  return { calls, failures };
}

/**
 * Where `query` (lower case) occurs in `text`, as `[start, end)` ranges, at most `limit` of them;
 * none for an empty query.
 */
export function matches(text: string, query: string, limit = 200): (readonly [number, number])[] {
  if (!query) return [];
  const lower = text.toLowerCase();
  const out: (readonly [number, number])[] = [];
  for (let at = lower.indexOf(query); at >= 0 && out.length < limit; at = lower.indexOf(query, at + query.length))
    out.push([at, at + query.length]);
  return out;
}
