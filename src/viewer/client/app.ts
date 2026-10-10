import type { ViewData, ViewGroup } from '../../view/types.js';
import { cats, type CatInfo } from './categories.js';
import { byId, el } from './dom.js';
import { drawAll } from './draw.js';
import { clock, dayStr, spansDays, stamp } from './format.js';
import { laneOf, LABEL_W, relayout, RIGHT, type Hit, type Lane, type LayoutItem, type Selection } from './layout.js';
import { bindPanels, markSelectedRow, renderDetail, renderPanels, renderStats, renderTrace } from './panels.js';
import { bindTimeline } from './interact.js';
import { applyTheme, cycleTheme, onThemeApplied } from './theme.js';
import {
  buildPieces,
  clampView,
  fitView,
  panView,
  revealView,
  Scale,
  TimeMap,
  zoomToRealView,
  zoomView,
  type Viewport,
} from './timeMap.js';
import type { TraceSort } from './trace.js';
import { colorOr } from './colors.js';

// The viewer of one session: its state, and the actions the timeline and the panels share. The
// drawing (draw.ts), the timeline's interactions (interact.ts), and the panels (panels.ts) read
// and change it through an App.

export type Tab = 'trace' | 'turns' | 'breakdown' | 'agents';

/** The elements the viewer draws in. */
export interface Elements {
  readonly tl: HTMLDivElement;
  readonly axis: HTMLCanvasElement;
  readonly lanes: HTMLCanvasElement;
  readonly overview: HTMLCanvasElement;
  readonly scroll: HTMLDivElement;
  readonly spacer: HTMLDivElement;
  readonly compress: HTMLInputElement;
  readonly q: HTMLInputElement;
  readonly kind: HTMLSelectElement;
  readonly inview: HTMLInputElement;
  readonly count: HTMLSpanElement;
  readonly traceWrap: HTMLDivElement;
  readonly detail: HTMLElement;
  readonly tip: HTMLDivElement;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('the browser has no 2D canvas');
  return ctx;
}

export class App {
  readonly data: ViewData;
  readonly lanes: readonly Lane[];
  readonly groups: readonly ViewGroup[];
  readonly laneById: ReadonlyMap<string, Lane>;
  readonly T0: number;
  readonly T1: number;
  /** The session spans local days, so times show their date. */
  readonly multiDay: boolean;
  readonly cats: readonly CatInfo[];
  readonly els: Elements;
  readonly actx: CanvasRenderingContext2D;
  readonly lctx: CanvasRenderingContext2D;
  readonly octx: CanvasRenderingContext2D;

  /** The lane whose trace the panels show. */
  cur: Lane;
  sel: Selection | null = null;
  hover: Hit | null = null;
  readonly collapsed = new Set<string>();
  layout: LayoutItem[] = [];
  contentH = 0;
  map: TimeMap = new TimeMap([{ r0: 0, r1: 1, d0: 0, d1: 1, gap: false }]);
  view: Viewport = { v0: 0, v1: 1 };
  cssW = 800;
  viewH = 300;
  plotW = 500;
  /** The stretch being dragged across the time axis, in x. */
  brush: { a: number; b: number } | null = null;
  activeTab: Tab = 'trace';
  traceSort: TraceSort = { by: 'time', dir: 1 };
  traceLimit = 500;
  private traceTimer: ReturnType<typeof setTimeout> | undefined;
  private drawQueued = false;
  private started = false;

  constructor(data: ViewData) {
    this.data = data;
    this.lanes = data.lanes.map(laneOf);
    this.groups = data.groups;
    this.laneById = new Map(this.lanes.map((l) => [l.id, l]));
    this.T0 = Math.min(...this.lanes.map((l) => l.start ?? NaN));
    this.T1 = Math.max(...this.lanes.map((l) => l.end ?? NaN));
    this.multiDay = spansDays(this.T0, this.T1);
    this.cats = cats(data.shellLabel);
    const [main] = this.lanes;
    if (main === undefined) throw new Error('the view data has no lane');
    this.cur = main;
    this.els = {
      tl: byId('tl', HTMLDivElement),
      axis: byId('axis', HTMLCanvasElement),
      lanes: byId('lanes', HTMLCanvasElement),
      overview: byId('overview', HTMLCanvasElement),
      scroll: byId('lanes-scroll', HTMLDivElement),
      spacer: byId('spacer', HTMLDivElement),
      compress: byId('compress', HTMLInputElement),
      q: byId('q', HTMLInputElement),
      kind: byId('kind', HTMLSelectElement),
      inview: byId('inview', HTMLInputElement),
      count: byId('count', HTMLSpanElement),
      traceWrap: byId('trace-wrap', HTMLDivElement),
      detail: byId('detail', HTMLElement),
      tip: byId('tip', HTMLDivElement),
    };
    this.actx = context(this.els.axis);
    this.lctx = context(this.els.lanes);
    this.octx = context(this.els.overview);
  }

  /** A time as the viewer shows it, with its date when the session spans days. */
  stamp = (t: number | null | undefined): string => stamp(t, this.multiDay);

  /** The main transcript's lane. */
  get main(): Lane {
    return this.lanes[0] ?? this.cur;
  }

  get scale(): Scale {
    return new Scale(this.map, this.view, LABEL_W, this.plotW);
  }

  /** Shows the session: the header, the timeline, and the panels, then keeps them in step. */
  start(): void {
    const { data, els } = this;
    byId('app', HTMLDivElement).hidden = false;
    document.title = `${data.session.title ?? data.session.id.slice(0, 8)} · trace`;
    byId('title', HTMLHeadingElement).textContent = data.session.title ?? data.session.id;
    byId('subtitle', HTMLSpanElement).textContent =
      `${data.session.id} · ${dayStr(this.T0)} ${clock(this.T0, false)} → ${dayStr(this.T1)} ${clock(this.T1, false)}`;
    byId('back', HTMLAnchorElement).hidden = data.serve !== true;
    // The shell filter is named after the agent's shell tool.
    for (const option of els.kind.options) if (option.value === 'shell') option.textContent = data.shellLabel;

    this.started = true;
    onThemeApplied(() => {
      this.requestDraw();
    });
    applyTheme();
    this.buildLegend();
    this.relayout();
    this.buildMapping();
    this.fit(false);
    this.sizeCanvases();
    bindTimeline(this);
    bindPanels(this);
    this.setLane(this.cur);
    const resized = new ResizeObserver(() => {
      this.sizeCanvases();
      this.requestDraw();
    });
    resized.observe(els.tl);
    resized.observe(els.scroll);
    byId('theme', HTMLButtonElement).addEventListener('click', () => {
      cycleTheme();
      this.buildLegend();
      renderPanels(this);
    });
  }

  /** A color key for the legend and the panels. */
  key(cat: string, line = false): HTMLSpanElement {
    return el('span', { class: `key${line ? ' line' : ''}`, style: `background:${colorOr(cat)}` });
  }

  buildLegend(): void {
    byId('legend', HTMLDivElement).replaceChildren(
      ...this.cats.map((c) => el('span', {}, this.key(c.key), c.label)),
      el('span', {}, this.key('critical'), '✗ Failed or interrupted'),
      el('span', {}, this.key('model', true), 'Background task until it reported'),
    );
  }

  // ---------- layout and time mapping ----------

  relayout(): void {
    const { layout, contentH } = relayout(this.groups, this.lanes, this.collapsed);
    this.layout = layout;
    this.contentH = contentH;
  }

  buildMapping(): void {
    this.map = new TimeMap(buildPieces(this.lanes, this.T0, this.T1, this.els.compress.checked));
  }

  /** Shows the window `view`, kept within the timeline when `clamp` is true, and redraws. */
  setView(view: Viewport, clamp = false): void {
    this.view = clamp ? clampView(view, this.map.total) : view;
    this.requestDraw();
  }

  fit(draw = true): void {
    this.view = fitView(this.map.total);
    if (draw) this.requestDraw();
  }

  /** Zooms by `factor` about the x `px` of the lanes canvas. */
  zoomAt(px: number, factor: number): void {
    this.setView(zoomView(this.view, this.scale.d(px), factor, this.map.total));
  }

  pan(dd: number): void {
    this.setView(panView(this.view, dd, this.map.total));
  }

  zoomToReal(r0: number, r1: number): void {
    this.setView(zoomToRealView(this.map, r0, r1));
  }

  /** Brings a real stretch into view, zooming only when it does not fit. */
  reveal(r0: number, r1: number): void {
    this.setView(revealView(this.view, this.map, r0, r1, this.plotW));
  }

  /** Scrolls the lanes to show `l`, expanding its group when it is collapsed. */
  scrollToLane(l: Lane): void {
    if (l.y == null) {
      this.collapsed.delete(l.group);
      this.relayout();
      this.sizeCanvases();
    }
    const sc = this.els.scroll;
    const y = l.y ?? 0;
    if (y < sc.scrollTop || y + l.height > sc.scrollTop + sc.clientHeight) sc.scrollTop = Math.max(0, y - 40);
  }

  // ---------- drawing ----------

  sizeCanvases(): void {
    const { els } = this;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = els.tl.clientWidth;
    this.plotW = Math.max(100, this.cssW - LABEL_W - RIGHT);
    const sc = els.scroll;
    if (!sc.dataset['sized']) {
      sc.style.height = `${Math.min(this.contentH, Math.max(240, Math.round(window.innerHeight * 0.55)))}px`;
      sc.dataset['sized'] = '1';
    }
    this.viewH = Math.max(60, Math.min(sc.clientHeight, this.contentH));
    els.spacer.style.height = `${Math.max(0, this.contentH - this.viewH)}px`;
    for (const [c, h] of [
      [els.axis, 28],
      [els.lanes, this.viewH],
      [els.overview, 30],
    ] as const) {
      c.width = Math.round(this.cssW * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${this.cssW}px`;
      c.style.height = `${h}px`;
      context(c).setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  requestDraw(): void {
    if (this.drawQueued || !this.started) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      drawAll(this);
      if (this.els.inview.checked && this.activeTab === 'trace') this.renderTraceDebounced();
    });
  }

  renderTraceDebounced(): void {
    clearTimeout(this.traceTimer);
    this.traceTimer = setTimeout(() => {
      renderTrace(this);
    }, 120);
  }

  // ---------- selection ----------

  setLane(l: Lane): void {
    this.cur = l;
    if (this.sel && this.sel.l !== l) this.sel = null;
    byId('lane-name', HTMLSpanElement).textContent = `${l.phase ? `${l.phase} · ` : ''}${l.label}`;
    renderStats(this);
    renderPanels(this);
    renderDetail(this);
    this.requestDraw();
  }

  /** Selects a span, a stretch, or a turn (anything else clears the selection), and shows it unless `pan` is false. */
  select(h: Hit | null, opts: { pan?: boolean } = {}): void {
    const sel = h && (h.type === 'span' || h.type === 'seg' || h.type === 'turn') ? h : null;
    this.sel = sel;
    if (sel && sel.l !== this.cur) this.setLane(sel.l);
    if (sel && opts.pan !== false) {
      this.scrollToLane(sel.l);
      if (sel.type === 'span') {
        const s = sel.l.spans[sel.i];
        if (s) this.reveal(s.s, s.e);
      } else if (sel.type === 'seg') {
        const g = sel.l.seg[sel.i];
        if (g) this.reveal(g[0], g[1]);
      } else {
        const t = sel.l.turns[sel.i];
        if (t) this.zoomToReal(t.ts, t.end);
      }
    }
    renderDetail(this);
    markSelectedRow(this);
    this.requestDraw();
  }

  /** Shows a lane: its trace below, the lanes scrolled to it, and the timeline zoomed to it. */
  showLane(l: Lane): void {
    this.setLane(l);
    this.scrollToLane(l);
    this.zoomToReal(l.start ?? NaN, l.end ?? NaN);
  }

  /** Selects the next (1) or previous (-1) span of the current lane, or its first or last. */
  step(dir: 1 | -1): void {
    const l = this.cur;
    if (!l.spans.length) return;
    let i = this.sel?.l === l && this.sel.type === 'span' ? this.sel.i + dir : dir > 0 ? 0 : l.spans.length - 1;
    i = Math.max(0, Math.min(l.spans.length - 1, i));
    this.select({ type: 'span', l, i });
  }

  /** Collapses a group, or expands it. */
  toggleGroup(g: ViewGroup): void {
    if (this.collapsed.has(g.id)) this.collapsed.delete(g.id);
    else this.collapsed.add(g.id);
    this.relayout();
    this.sizeCanvases();
    this.requestDraw();
  }
}
