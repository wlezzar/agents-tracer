import type { ConversationTurn, ModelItem } from '../../view/types.js';
import { el, svg } from './dom.js';
import { kTok } from './format.js';

// The conversation page's chart of the context: the tokens each model call read, call after call,
// with a vertical hairline where the context was compacted. One series in the model's color; the crosshair
// snaps to the nearest call, and a click shows that call in the conversation.

/** A model call that recorded its context. */
export interface ContextPoint {
  readonly model: ModelItem;
  readonly context: number;
  /** The number of its turn. */
  readonly turn: number;
}

/** The thread's model calls that recorded their context, in order, and where compactions fell between them. */
export function contextSeries(turns: readonly ConversationTurn[]): {
  readonly points: readonly ContextPoint[];
  /** Each compaction's place, as the number of points before it. */
  readonly compactions: readonly number[];
} {
  const points: ContextPoint[] = [];
  const compactions: number[] = [];
  for (const t of turns)
    for (const i of t.items) {
      if (i.type === 'model' && i.context !== null) points.push({ model: i, context: i.context, turn: t.n });
      if (i.type === 'compaction') compactions.push(points.length);
    }
  return { points, compactions };
}

/** The plot's geometry: the points' x and y in a box of `width` by `height`, inset by `pad`. */
export class ChartScale {
  readonly width: number;
  readonly height: number;
  readonly pad: number;
  readonly count: number;
  readonly max: number;

  constructor(width: number, height: number, pad: number, count: number, max: number) {
    this.width = width;
    this.height = height;
    this.pad = pad;
    this.count = count;
    this.max = max;
  }

  x(i: number): number {
    const span = this.width - 2 * this.pad;
    return this.pad + (this.count <= 1 ? span / 2 : (i * span) / (this.count - 1));
  }

  y(v: number): number {
    return this.height - this.pad - (this.max > 0 ? (v / this.max) * (this.height - 2 * this.pad) : 0);
  }

  /** The index of the point nearest the x `px`. */
  nearest(px: number): number {
    if (this.count <= 1) return 0;
    const span = this.width - 2 * this.pad;
    const i = Math.round(((px - this.pad) * (this.count - 1)) / span);
    return Math.max(0, Math.min(this.count - 1, i));
  }
}

const HEIGHT = 72;
const PAD = 6;

/**
 * Draws the chart in `host`, `width` wide; `pick` shows a call in the conversation, `tip` shows a
 * readout by the pointer (null hides it).
 */
export function drawContextChart(
  host: HTMLElement,
  turns: readonly ConversationTurn[],
  width: number,
  pick: (model: ModelItem) => void,
  tip: (
    at: { readonly x: number; readonly y: number; readonly point: ContextPoint; readonly index: number } | null,
  ) => void,
): void {
  const { points, compactions } = contextSeries(turns);
  if (points.length < 2) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const max = points.reduce((m, p) => Math.max(m, p.context), 0);
  const scale = new ChartScale(width, HEIGHT, PAD, points.length, max);
  let peak = 0;
  points.forEach((p, i) => {
    if (p.context > (points[peak]?.context ?? 0)) peak = i;
  });
  const line = points.map((p, i) => `${scale.x(i).toFixed(1)},${scale.y(p.context).toFixed(1)}`).join(' ');
  const cross = svg('line', { class: 'cv-cross', x1: 0, x2: 0, y1: 0, y2: HEIGHT, visibility: 'hidden' });
  const dot = svg('circle', { class: 'cv-dot', r: 4, cx: 0, cy: 0, visibility: 'hidden' });
  const peakPoint = points[peak];
  const chart = svg(
    'svg',
    { width, height: HEIGHT, role: 'img', 'aria-label': `Context per model call, peak ${kTok(max)} tokens` },
    svg('line', { class: 'cv-base', x1: PAD, x2: width - PAD, y1: HEIGHT - PAD, y2: HEIGHT - PAD }),
    ...compactions.map((at) => {
      const x = (scale.x(Math.max(0, at - 1)) + scale.x(Math.min(points.length - 1, at))) / 2;
      return svg('line', { class: 'cv-compaction-mark', x1: x, x2: x, y1: PAD, y2: HEIGHT - PAD });
    }),
    svg('polyline', { class: 'cv-line', points: line }),
    cross,
    peakPoint ? svg('circle', { class: 'cv-peak', r: 4, cx: scale.x(peak), cy: scale.y(peakPoint.context) }) : '',
    dot,
  );
  const at = (e: PointerEvent): number => scale.nearest(e.clientX - chart.getBoundingClientRect().left);
  chart.addEventListener('pointermove', (e) => {
    const i = at(e);
    const p = points[i];
    if (!p) return;
    const x = scale.x(i);
    cross.setAttribute('x1', String(x));
    cross.setAttribute('x2', String(x));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(scale.y(p.context)));
    dot.setAttribute('visibility', 'visible');
    tip({ x: e.clientX, y: e.clientY, point: p, index: i });
  });
  chart.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip(null);
  });
  chart.addEventListener('click', (e) => {
    const p = points[at(e)];
    if (p) pick(p.model);
  });
  const peakLabel =
    peakPoint === undefined
      ? null
      : el(
          'span',
          {
            class: 'cv-peak-label',
            style: `left:${Math.min(width - 120, Math.max(0, scale.x(peak) - 40)).toFixed(0)}px`,
          },
          `peak ${kTok(max)}`,
        );
  host.replaceChildren(
    el(
      'div',
      { class: 'cv-chart-head' },
      el('span', { class: 'who' }, 'Context per model call'),
      el(
        'span',
        { class: 'muted' },
        `tokens each call read (input, cache reads and writes), ${points.length} calls${compactions.length ? ' · a vertical line is a compaction' : ''} · click to show a call`,
      ),
    ),
    el('div', { class: 'cv-chart-plot' }, peakLabel, chart),
  );
}
