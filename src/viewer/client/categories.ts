import type { ToolCategory, ViewSpan } from '../../view/types.js';
import { cap } from './format.js';

// What the viewer colors by: the model, the shell, other tools, and the kinds of waiting. Spans
// and buckets map to these by the tool's category, never by its name.

/** A color of the viewer, which its CSS defines in both themes. */
export type Cat = 'model' | 'shell' | 'tool' | 'you' | 'youbg' | 'bg';

export interface CatInfo {
  readonly key: Cat;
  readonly label: string;
  /** The CSS custom property that holds its color. */
  readonly css: string;
}

/** The colors, in the legend's order; the shell's is labeled with the agent's shell tool. */
export function cats(shellLabel: string): readonly CatInfo[] {
  return [
    { key: 'model', label: 'Model', css: '--series-1' },
    { key: 'shell', label: shellLabel, css: '--series-2' },
    { key: 'tool', label: 'Other tools', css: '--series-3' },
    { key: 'you', label: 'Waiting on you', css: '--wait-you' },
    { key: 'youbg', label: 'Waiting on you, background tasks running', css: '--wait-youbg' },
    { key: 'bg', label: 'Waiting on a background task', css: '--wait-bg' },
  ];
}

/** True for the idle buckets. */
export function isIdle(bucket: string): boolean {
  return bucket.startsWith('idle');
}

/** The color of a bucket; a `tool:` bucket's by its tool's category. */
export function catOfBucket(bucket: string, categories: Readonly<Record<string, ToolCategory>>): Cat {
  if (bucket === 'model' || bucket === 'compaction') return 'model';
  if (bucket.startsWith('tool:')) {
    const name = bucket.slice(5);
    return Object.hasOwn(categories, name) && categories[name] === 'shell' ? 'shell' : 'tool';
  }
  if (bucket === 'idle: waiting on a background task') return 'bg';
  if (bucket === 'idle: waiting on you, background tasks running') return 'youbg';
  return 'you';
}

/** The color of a span: the model's, the shell's, the person's for a question, or other tools'. */
export function catOfSpan(span: ViewSpan): Cat {
  if (span.t === 'm') return 'model';
  return span.cat === 'shell' ? 'shell' : span.cat === 'question' ? 'you' : 'tool';
}

/** How a bucket reads in the viewer: `Model`, a tool's name, `Waiting on you`. */
export function bucketLabel(bucket: string): string {
  if (bucket === 'model') return 'Model';
  if (bucket === 'compaction') return 'Compaction (model)';
  if (bucket.startsWith('tool:')) return bucket.slice(5);
  if (bucket === 'you: answering questions') return 'You, answering questions';
  if (bucket.startsWith('idle: ')) return cap(bucket.slice(6));
  return bucket;
}

export function spanName(span: ViewSpan): string {
  return span.t === 'm' ? 'Model response' : span.name;
}

/** A span's one line: a model call's summary, a tool call's preview. */
export function spanDetail(span: ViewSpan): string {
  return span.t === 'm' ? span.sum : span.pv;
}

/** A tool call that failed or was interrupted. */
export function failed(span: ViewSpan): boolean {
  return span.t === 't' && (span.err || span.intr);
}
