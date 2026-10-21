import type { Thread, ThreadGroup, ToolCategory } from '../../view/types.js';
import { bucketLabel, catOfBucket } from './categories.js';
import { color } from './colors.js';
import { el } from './dom.js';
import { fmt, kTok } from './format.js';
import {
  buildPieces,
  clampView,
  fitView,
  panView,
  Scale,
  TimeMap,
  zoomToRealView,
  zoomView,
  type Viewport,
} from './timeMap.js';
import { fitText, ticks } from './ticks.js';

// The conversation page's tree of agents over time: a thin row per thread under the thread that
// launched it, and a row per group of agents (such as a workflow run) over its agents, all on one
// time axis whose idle stretches collapse as the timeline's do. A thread's bar is its state track,
// in the timeline's colors, led in from the moment the call that launched it ran; the hovered and
// the shown thread's lead-ins run up to their parent's row. A group's row and the row above the
// tree shade how many agents ran at once. Dragging across the axis zooms to a stretch, as does
// double-clicking a row; Ctrl or Cmd and the wheel zoom about the pointer.

/** The width of the labels, left of the plot, and the margin right of it. */
const LABEL_W = 260;
const RIGHT = 10;
/** The heights of the axis, of the row of agents at once above the tree, of a row, and of a thread's bar. */
const AXIS_H = 20;
const ONCE_H = 24;
const ROW_H = 18;
const BAR_H = 8;
/** A label's indent per level of the tree. */
const INDENT = 14;
/** A group of more agents than this starts folded. */
export const FOLD_OVER = 6;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** A node of the tree: a thread, or a group of agents. */
export interface TreeNode {
  /** The thread's id, or `group:` and the group's id. */
  readonly key: string;
  readonly thread: Thread | null;
  readonly group: ThreadGroup | null;
  /** The thread, or the group's agents. */
  readonly members: readonly Thread[];
  readonly children: TreeNode[];
  readonly start: number | null;
  readonly end: number | null;
  /** When the tool call that launched it started; null when not known. */
  readonly launched: number | null;
}

/** A row of the tree as it is shown: its node, its depth, and the index of its parent's row. */
export interface TreeRow {
  readonly node: TreeNode;
  readonly depth: number;
  readonly parent: number | null;
}

/** The earliest and the latest of some times, null when none is known. */
function extent(threads: readonly Thread[]): { start: number | null; end: number | null } {
  const starts = threads.flatMap((t) => (t.start === null ? [] : [t.start]));
  const ends = threads.flatMap((t) => (t.end === null ? [] : [t.end]));
  return {
    start: starts.length ? Math.min(...starts) : null,
    end: ends.length ? Math.max(...ends) : null,
  };
}

/**
 * The tree of a session's threads, from the main one: each agent under the thread that launched
 * it, an agent of a group under the group (unless another agent of the group launched it), and a
 * group under the thread whose call started it. Children are in order of start.
 */
export function agentTree(threads: readonly Thread[], groups: readonly ThreadGroup[]): TreeNode | null {
  const [main] = threads;
  if (main === undefined) return null;
  const byId = new Map(threads.map((t) => [t.id, t]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const callStart = new Map<string, number>(); // a tool call's id -> its start
  const agentCall = new Map<string, number>(); // an agent's id -> the start of a call that launched it
  for (const t of threads)
    for (const turn of t.turns)
      for (const i of turn.items)
        if (i.type === 'model')
          for (const b of i.blocks)
            if (b.type === 'tool') {
              callStart.set(b.id, b.start);
              if (b.agent !== null) agentCall.set(b.agent, b.start);
            }

  const nodes = new Map<string, TreeNode>();
  for (const t of threads)
    nodes.set(t.id, {
      key: t.id,
      thread: t,
      group: null,
      members: [t],
      children: [],
      start: t.start,
      end: t.end,
      launched:
        t === main
          ? null
          : ((t.launcher === null ? undefined : callStart.get(t.launcher)) ?? agentCall.get(t.id) ?? null),
    });
  for (const g of groups) {
    const members = threads.filter((t) => t.group === g.id);
    nodes.set(`group:${g.id}`, {
      key: `group:${g.id}`,
      thread: null,
      group: g,
      members,
      children: [],
      ...extent(members),
      launched: g.launcher === null ? null : (callStart.get(g.launcher) ?? null),
    });
  }

  const parentOf = new Map<string, string>();
  for (const n of nodes.values()) {
    if (n.thread === main) continue;
    if (n.group !== null) {
      parentOf.set(n.key, n.group.parent !== null && byId.has(n.group.parent) ? n.group.parent : main.id);
      continue;
    }
    const t = n.thread;
    if (t === null) continue;
    const p = t.parent !== null && byId.has(t.parent) ? t.parent : null;
    const g = t.group === null ? undefined : groupById.get(t.group);
    // An agent its group's own agent launched sits under that agent; any other, under the group.
    if (g !== undefined)
      parentOf.set(n.key, p !== null && p !== g.parent && byId.get(p)?.group === g.id ? p : `group:${g.id}`);
    else parentOf.set(n.key, p ?? main.id);
  }
  // A node whose parents lead back to it hangs from the main thread instead.
  for (const key of parentOf.keys()) {
    const seen = new Set([key]);
    for (let up = parentOf.get(key); up !== undefined; up = parentOf.get(up)) {
      if (seen.has(up)) {
        parentOf.set(key, main.id);
        break;
      }
      seen.add(up);
    }
  }
  for (const [key, parent] of parentOf) {
    const n = nodes.get(key);
    if (n !== undefined) nodes.get(parent)?.children.push(n);
  }
  const at = (n: TreeNode): number => n.start ?? n.launched ?? Infinity;
  for (const n of nodes.values()) n.children.sort((x, y) => at(x) - at(y));
  return nodes.get(main.id) ?? null;
}

/** The rows the tree shows, depth first, without the children of the nodes in `folded`. */
export function treeRows(root: TreeNode, folded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number, parent: number | null): void => {
    const index = rows.length;
    rows.push({ node, depth, parent });
    if (!folded.has(node.key)) for (const c of node.children) walk(c, depth + 1, index);
  };
  walk(root, 0, null);
  return rows;
}

/** How many of `threads` ran at each moment: a step at each time the count changes, and its peak. */
export function concurrency(threads: readonly Thread[]): {
  readonly steps: readonly (readonly [time: number, running: number])[];
  readonly peak: number;
} {
  const events: [number, number][] = [];
  for (const t of threads) if (t.start !== null && t.end !== null) events.push([t.start, 1], [t.end, -1]);
  // An end before a start at the same time, so that one agent following another is not two at once.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const steps: [number, number][] = [];
  let running = 0;
  let peak = 0;
  for (const [time, d] of events) {
    running += d;
    peak = Math.max(peak, running);
    const last = steps.at(-1);
    if (last?.[0] === time) last[1] = running;
    else steps.push([time, running]);
  }
  return { steps, peak };
}

/** The keys of the nodes below `root` that start folded: the groups of more than {@link FOLD_OVER} agents. */
export function initiallyFolded(root: TreeNode): Set<string> {
  const folded = new Set<string>();
  const walk = (n: TreeNode): void => {
    if (n.group !== null && n.members.length > FOLD_OVER) folded.add(n.key);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return folded;
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('the browser has no 2D canvas');
  return ctx;
}

/** What the tree's page gives it: where to draw, and what to do on a click. */
export interface AgentTreeHost {
  readonly axis: HTMLCanvasElement;
  readonly rows: HTMLCanvasElement;
  readonly scroll: HTMLDivElement;
  readonly spacer: HTMLDivElement;
  readonly tip: HTMLDivElement;
  readonly compress: HTMLInputElement;
  /** Shows the whole session again; hidden while it is shown. */
  readonly fit: HTMLButtonElement;
  /** The session spans local days, so times show their date. */
  readonly multiDay: boolean;
  /** Formats a time, with its date when the session spans days. */
  readonly stamp: (t: number | null) => string;
  /** Shows a thread's conversation. */
  readonly open: (t: Thread) => void;
}

/** The tree of agents over time, drawn on its two canvases and kept in step with the page. */
export class AgentTree {
  private readonly host: AgentTreeHost;
  private readonly root: TreeNode;
  private readonly threads: readonly Thread[];
  private readonly byId: ReadonlyMap<string, Thread>;
  private readonly categories: Readonly<Record<string, ToolCategory>>;
  private readonly folded: Set<string>;
  private readonly once: ReturnType<typeof concurrency>;
  private readonly groupOnce = new Map<string, ReturnType<typeof concurrency>>();
  private rows: TreeRow[] = [];
  private map: TimeMap = new TimeMap([{ r0: 0, r1: 1, d0: 0, d1: 1, gap: false }]);
  private view: Viewport = { v0: 0, v1: 1 };
  /** The stretch being dragged across the axis, in x. */
  private brush: { a: number; b: number } | null = null;
  private cssW = 800;
  private viewH = 0;
  private current: string;
  private hover: number | null = null;
  private cursor: number | null = null;
  private queued = false;
  readonly T0: number;
  readonly T1: number;

  constructor(host: AgentTreeHost, root: TreeNode, threads: readonly Thread[]) {
    this.host = host;
    this.root = root;
    this.threads = threads;
    this.byId = new Map(threads.map((t) => [t.id, t]));
    this.current = root.key;
    this.folded = initiallyFolded(root);
    this.once = concurrency(threads.slice(1));
    const categories = new Map<string, ToolCategory>();
    for (const t of threads)
      for (const turn of t.turns)
        for (const i of turn.items)
          if (i.type === 'model') for (const b of i.blocks) if (b.type === 'tool') categories.set(b.name, b.category);
    // fromEntries defines own properties, so that a tool named __proto__ is a key like any other.
    this.categories = Object.fromEntries(categories);
    const { start, end } = extent(threads);
    this.T0 = start ?? 0;
    this.T1 = Math.max(end ?? 1, this.T0 + 1);
    this.rows = treeRows(root, this.folded);
    this.buildMapping();
    this.bind();
  }

  /** How many agents ran at once at most. */
  get peak(): number {
    return this.once.peak;
  }

  private buildMapping(): void {
    const lanes = this.threads.map((t) => ({ seg: t.segments, spans: [], turns: t.turns }));
    this.map = new TimeMap(buildPieces(lanes, this.T0, this.T1, this.host.compress.checked));
    this.setView(fitView(this.map.total));
  }

  /** Shows the window `view`, kept within the session. */
  private setView(view: Viewport): void {
    this.view = clampView(view, this.map.total);
    const whole = fitView(this.map.total);
    this.host.fit.hidden = this.view.v0 <= whole.v0 && this.view.v1 >= whole.v1;
    this.draw();
  }

  /** Shows the whole session. */
  fitAll(): void {
    this.setView(fitView(this.map.total));
  }

  private get plotW(): number {
    return Math.max(100, this.cssW - LABEL_W - RIGHT);
  }

  private get scale(): Scale {
    return new Scale(this.map, this.view, LABEL_W, this.plotW);
  }

  /** Marks the shown thread, unfolding what hides it and scrolling to it. */
  setCurrent(id: string): void {
    this.current = id;
    const thread = this.byId.get(id);
    let hidden = false;
    for (const r of this.ancestors(id)) hidden = this.folded.delete(r) || hidden;
    if (hidden) this.relayout();
    const i = this.rows.findIndex((r) => r.node.thread === thread);
    const sc = this.host.scroll;
    const y = i * ROW_H;
    if (i >= 0 && (y < sc.scrollTop || y + ROW_H > sc.scrollTop + sc.clientHeight))
      sc.scrollTop = Math.max(0, y - 2 * ROW_H);
    this.draw();
  }

  /** Marks a moment on every row, such as the start of the turn the page shows; null clears it. */
  setCursor(t: number | null): void {
    if (t === this.cursor) return;
    this.cursor = t;
    this.draw();
  }

  /** The keys of the nodes above a thread's. */
  private ancestors(id: string): string[] {
    const path: string[] = [];
    const find = (n: TreeNode): boolean => {
      if (n.key === id) return true;
      for (const c of n.children)
        if (find(c)) {
          path.push(n.key);
          return true;
        }
      return false;
    };
    find(this.root);
    return path;
  }

  private toggle(key: string): void {
    if (!this.folded.delete(key)) this.folded.add(key);
    this.relayout();
  }

  private relayout(): void {
    this.rows = treeRows(this.root, this.folded);
    this.resize();
  }

  /** Sizes the canvases to the page and the rows, then draws. */
  resize(): void {
    const { axis, rows, scroll, spacer } = this.host;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = scroll.clientWidth;
    const contentH = this.rows.length * ROW_H;
    this.viewH = Math.min(contentH, Math.max(5 * ROW_H, Math.round(Math.min(window.innerHeight * 0.42, 22 * ROW_H))));
    scroll.style.height = `${this.viewH}px`;
    spacer.style.height = `${Math.max(0, contentH - this.viewH)}px`;
    for (const [c, h] of [
      [axis, AXIS_H + ONCE_H],
      [rows, this.viewH],
    ] as const) {
      c.width = Math.round(this.cssW * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${this.cssW}px`;
      c.style.height = `${h}px`;
      canvasContext(c).setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.draw();
  }

  /** Draws on the next frame. */
  draw(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.drawAxis();
      this.drawRows();
    });
  }

  private onceOf(n: TreeNode): ReturnType<typeof concurrency> {
    let c = this.groupOnce.get(n.key);
    if (c === undefined) {
      c = concurrency(n.members);
      this.groupOnce.set(n.key, c);
    }
    return c;
  }

  // ---------- drawing ----------

  private drawAxis(): void {
    const ctx = canvasContext(this.host.axis);
    const scale = this.scale;
    const h = AXIS_H + ONCE_H;
    ctx.clearRect(0, 0, this.cssW, h);
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color('text-secondary');
    ctx.fillText(`At once · at most ${this.once.peak}`, 12, AXIS_H + ONCE_H / 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, this.plotW, h);
    ctx.clip();
    for (const p of this.map.pieces) {
      if (!p.gap || p.d1 < this.view.v0 || p.d0 > this.view.v1) continue;
      const x0 = scale.x(p.d0);
      const x1 = scale.x(p.d1);
      ctx.fillStyle = color('gap-band');
      ctx.fillRect(x0, 0, x1 - x0, h);
      const label = `⋯ ${fmt(p.r1 - p.r0)}`;
      const w = ctx.measureText(label).width;
      ctx.fillStyle = color('muted');
      if (w + 6 < x1 - x0) ctx.fillText(label, (x0 + x1) / 2 - w / 2, AXIS_H / 2);
    }
    for (const t of ticks(scale, this.host.multiDay)) {
      ctx.fillStyle = color('axis');
      ctx.fillRect(Math.round(t.x), AXIS_H - 5, 1, 5);
      if (t.x + 4 + ctx.measureText(t.label).width > LABEL_W + this.plotW) continue;
      ctx.fillStyle = color('text-secondary');
      ctx.fillText(t.label, t.x + 4, AXIS_H / 2);
    }
    this.density(ctx, scale, this.once, AXIS_H + 2, ONCE_H - 4, 0.4);
    this.drawCursor(ctx, scale, 0, h);
    if (this.brush !== null) {
      const a = Math.min(this.brush.a, this.brush.b);
      const w = Math.abs(this.brush.b - this.brush.a);
      ctx.fillStyle = color('wash');
      ctx.fillRect(a, 0, w, h);
      ctx.fillStyle = color('text-primary');
      ctx.fillRect(a, 0, 1, h);
      ctx.fillRect(a + w, 0, 1, h);
    }
    ctx.restore();
  }

  /** Shades how many ran at once, `steps` scaled to their peak, in a band from `top`, `h` tall. */
  private density(
    ctx: CanvasRenderingContext2D,
    scale: Scale,
    { steps, peak }: ReturnType<typeof concurrency>,
    top: number,
    h: number,
    alpha: number,
  ): void {
    if (peak === 0) return;
    ctx.fillStyle = color('text-secondary');
    ctx.globalAlpha = alpha;
    steps.forEach(([t, n], i) => {
      const next = steps[i + 1];
      if (n === 0 || next === undefined) return;
      const x0 = scale.xt(t);
      const x1 = scale.xt(next[0]);
      const bh = Math.max(1, (n / peak) * h);
      ctx.fillRect(x0, top + h - bh, Math.max(1, x1 - x0), bh);
    });
    ctx.globalAlpha = 1;
  }

  private drawCursor(ctx: CanvasRenderingContext2D, scale: Scale, top: number, h: number): void {
    if (this.cursor === null) return;
    ctx.fillStyle = color('text-primary');
    ctx.globalAlpha = 0.6;
    ctx.fillRect(Math.round(scale.xt(this.cursor)), top, 1, h);
    ctx.globalAlpha = 1;
  }

  private drawRows(): void {
    const ctx = canvasContext(this.host.rows);
    const scale = this.scale;
    const top = this.host.scroll.scrollTop;
    const { cssW, viewH, plotW } = this;
    ctx.clearRect(0, 0, cssW, viewH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, plotW, viewH);
    ctx.clip();
    for (const p of this.map.pieces) {
      if (!p.gap) continue;
      ctx.fillStyle = color('gap-band');
      ctx.fillRect(scale.x(p.d0), 0, scale.x(p.d1) - scale.x(p.d0), viewH);
    }
    ctx.restore();

    const first = Math.max(0, Math.floor(top / ROW_H));
    const last = Math.min(this.rows.length - 1, Math.ceil((top + viewH) / ROW_H));
    // Backgrounds and labels.
    for (let i = first; i <= last; i++) {
      const r = this.rows[i];
      if (r === undefined) continue;
      const y = i * ROW_H - top;
      const n = r.node;
      const isCur = n.thread !== null && n.thread.id === this.current;
      if (isCur) {
        ctx.fillStyle = color('wash');
        ctx.fillRect(0, y, cssW, ROW_H);
      } else if (this.hover === i) {
        ctx.fillStyle = color('hover');
        ctx.fillRect(0, y, cssW, ROW_H);
      }
      const x = 12 + r.depth * INDENT;
      ctx.textBaseline = 'middle';
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = color('muted');
      if (n.children.length) ctx.fillText(this.folded.has(n.key) ? '▸' : '▾', x, y + ROW_H / 2);
      // A group's count of agents, right-aligned, so that a long name does not cut it off.
      let room = LABEL_W - x - 18;
      if (n.group !== null) {
        const agents = String(n.members.length);
        ctx.font = `11px ${FONT}`;
        const w = ctx.measureText(agents).width;
        ctx.fillText(agents, LABEL_W - 10 - w, y + ROW_H / 2 + 0.5);
        room -= w + 8;
      }
      ctx.font = `${isCur || n.group !== null ? '600 ' : ''}12px ${FONT}`;
      ctx.fillStyle = color('text-primary');
      ctx.fillText(
        fitText((t) => ctx.measureText(t).width, this.labelOf(n), room),
        x + 12,
        y + ROW_H / 2 + 0.5,
      );
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, plotW, viewH);
    ctx.clip();
    // The lead-ins first, so that the bars cover them: from a tick where the launching call ran to
    // the start; the hovered and the shown thread's from their parent's row, however far above.
    ctx.lineWidth = 1;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r?.parent == null || r.node.launched === null) continue;
      const y = Math.round(i * ROW_H - top + ROW_H / 2) + 0.5;
      const full = this.hover === i || r.node.thread?.id === this.current;
      const py = full ? r.parent * ROW_H - top + ROW_H / 2 + BAR_H / 2 : y - BAR_H / 2;
      if (py > viewH || y < 0 || (!full && (i < first || i > last))) continue;
      const x = Math.round(scale.xt(r.node.launched)) + 0.5;
      const xs = r.node.start === null ? x : scale.xt(r.node.start);
      ctx.strokeStyle = color(full ? 'text-secondary' : 'axis');
      ctx.beginPath();
      ctx.moveTo(x, py);
      ctx.lineTo(x, y);
      ctx.lineTo(xs, y);
      ctx.stroke();
    }
    for (let i = first; i <= last; i++) {
      const r = this.rows[i];
      if (r === undefined) continue;
      const y = i * ROW_H - top;
      if (r.node.thread !== null) this.bar(ctx, scale, r.node.thread, y + (ROW_H - BAR_H) / 2);
      else {
        const { start, end } = r.node;
        if (start !== null && end !== null) {
          ctx.fillStyle = color('axis');
          ctx.fillRect(scale.xt(start), y + ROW_H - 3, Math.max(1, scale.xt(end) - scale.xt(start)), 1);
        }
        this.density(ctx, scale, this.onceOf(r.node), y + 2, ROW_H - 5, 0.45);
      }
    }
    this.drawCursor(ctx, scale, 0, viewH);
    ctx.restore();
  }

  /** A thread's state track, as one bar: what was pending, in the timeline's colors, stretches under a pixel merged. */
  private bar(ctx: CanvasRenderingContext2D, scale: Scale, t: Thread, y: number): void {
    const left = LABEL_W - 2;
    const right = LABEL_W + this.plotW + 2;
    let run: { x0: number; x1: number; fill: string } | null = null;
    const flush = (): void => {
      if (run === null) return;
      ctx.fillStyle = run.fill;
      ctx.fillRect(run.x0, y, Math.max(1, run.x1 - run.x0), BAR_H);
      run = null;
    };
    for (const [s, e, b] of t.segments) {
      const x0 = scale.xt(s);
      const x1 = scale.xt(e);
      if (x1 < left || x0 > right) continue;
      const fill = color(catOfBucket(b, this.categories));
      if (run !== null && run.fill === fill && x0 <= run.x1 + 0.5) run.x1 = Math.max(run.x1, x1);
      else {
        flush();
        run = { x0, x1, fill };
      }
    }
    flush();
  }

  /** Where a thread came from: the call of its parent that launched it, or the group it ran in and who started that. */
  private launchLine(r: TreeRow, parent: Thread | undefined): HTMLElement | null {
    const { stamp } = this.host;
    const at = (t: number | null): string => (t === null ? '' : ` at ${stamp(t)}`);
    const above = r.parent === null ? undefined : this.rows[r.parent]?.node;
    const g = above?.group;
    if (above !== undefined && g != null) {
      const starter = g.parent === null ? undefined : this.byId.get(g.parent);
      return el(
        'div',
        { class: 'd' },
        `In ${g.label}${starter === undefined ? '' : `, started${at(above.launched)} by ${starter.label}`}`,
      );
    }
    if (parent === undefined) return null;
    return el('div', { class: 'd' }, `Launched${at(r.node.launched)} by ${parent.label}`);
  }

  private labelOf(n: TreeNode): string {
    if (n.group !== null) return n.group.label;
    const t = n.thread;
    if (t === null) return n.key;
    return `${t.phase ? `${t.phase} · ` : ''}${t.label}`;
  }

  // ---------- interaction ----------

  private bind(): void {
    const { rows, axis, scroll, compress, fit } = this.host;
    scroll.addEventListener('scroll', () => {
      this.hideTip();
      this.draw();
    });
    rows.addEventListener('mousemove', (e) => {
      const at = this.rowAt(e);
      if (at !== this.hover) {
        this.hover = at;
        this.draw();
      }
      rows.style.cursor = at === null ? 'default' : 'pointer';
      this.showTip(e, at === null ? null : this.rows[at], e.offsetX);
    });
    rows.addEventListener('mouseleave', () => {
      this.hover = null;
      this.hideTip();
      this.draw();
    });
    rows.addEventListener('click', (e) => {
      const at = this.rowAt(e);
      const r = at === null ? undefined : this.rows[at];
      if (r === undefined) return;
      const twist = 12 + r.depth * INDENT;
      if (r.node.thread === null || (r.node.children.length && e.offsetX >= twist - 4 && e.offsetX < twist + 12))
        this.toggle(r.node.key);
      else this.host.open(r.node.thread);
    });
    rows.addEventListener('dblclick', (e) => {
      const at = this.rowAt(e);
      const n = at === null ? undefined : this.rows[at]?.node;
      if (n?.start != null && n.end !== null) this.setView(zoomToRealView(this.map, n.start, n.end));
    });
    const plotX = (e: MouseEvent): number =>
      Math.max(LABEL_W, Math.min(LABEL_W + this.plotW, e.clientX - axis.getBoundingClientRect().left));
    axis.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.offsetX < LABEL_W) return;
      e.preventDefault();
      this.brush = { a: plotX(e), b: plotX(e) };
      this.hideTip();
      const move = (m: MouseEvent): void => {
        if (this.brush !== null) this.brush.b = plotX(m);
        this.draw();
      };
      const up = (): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const b = this.brush;
        this.brush = null;
        if (b !== null && Math.abs(b.b - b.a) > 4) {
          const scale = this.scale;
          this.setView({ v0: scale.d(Math.min(b.a, b.b)), v1: scale.d(Math.max(b.a, b.b)) });
        } else this.draw();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    axis.addEventListener('dblclick', () => {
      this.fitAll();
    });
    const wheel = (e: WheelEvent): void => {
      const scale = this.scale;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const x = Math.max(LABEL_W, e.offsetX);
        this.setView(zoomView(this.view, scale.d(x), Math.exp(e.deltaY * 0.002), this.map.total));
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.setView(panView(this.view, (e.deltaX * (this.view.v1 - this.view.v0)) / this.plotW, this.map.total));
      }
    };
    rows.addEventListener('wheel', wheel, { passive: false });
    axis.addEventListener('wheel', wheel, { passive: false });
    fit.addEventListener('click', () => {
      this.fitAll();
    });
    axis.addEventListener('mousemove', (e) => {
      if (this.brush !== null || e.offsetY < AXIS_H || e.offsetX < LABEL_W) {
        this.hideTip();
        return;
      }
      const t = this.map.toReal(this.scale.d(e.offsetX));
      const step = this.once.steps.findLast(([s]) => s <= t);
      this.tipAt(e, [
        el('div', { class: 'v' }, `${step?.[1] ?? 0} agents running`),
        el('div', { class: 'd' }, this.host.stamp(t)),
      ]);
    });
    axis.addEventListener('mouseleave', () => {
      this.hideTip();
    });
    compress.addEventListener('change', () => {
      this.buildMapping();
      this.draw();
    });
  }

  private rowAt(e: MouseEvent): number | null {
    const i = Math.floor((e.offsetY + this.host.scroll.scrollTop) / ROW_H);
    return i >= 0 && i < this.rows.length ? i : null;
  }

  private hideTip(): void {
    this.host.tip.hidden = true;
  }

  private tipAt(e: MouseEvent, lines: readonly HTMLElement[]): void {
    const tip = this.host.tip;
    tip.replaceChildren(...lines);
    tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - 300, e.clientX + 14)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  }

  private showTip(e: MouseEvent, r: TreeRow | undefined | null, x: number): void {
    if (r == null) {
      this.hideTip();
      return;
    }
    const { stamp } = this.host;
    const n = r.node;
    const d = (text: string): HTMLElement => el('div', { class: 'd' }, text);
    const when = n.start === null ? 'no events' : `${stamp(n.start)} → ${stamp(n.end)}`;
    if (n.group !== null) {
      const g = n.group;
      const once = this.onceOf(n);
      this.tipAt(e, [
        el('div', { class: 'v' }, g.label),
        d(
          [g.status, `${n.members.length} agents`, `at most ${once.peak} at once`]
            .filter((s) => s !== null)
            .join(' · '),
        ),
        d(when),
        d(
          [
            g.ms === null ? null : fmt(g.ms),
            g.tokens === null ? null : `${kTok(g.tokens)} tokens`,
            g.toolCalls === null ? null : `${g.toolCalls} tool calls`,
          ]
            .filter((s) => s !== null)
            .join(' · '),
        ),
        d(this.folded.has(n.key) ? 'Click to unfold' : 'Click to fold'),
      ]);
      return;
    }
    const t = n.thread;
    if (t === null) return;
    const s = t.stats;
    const parent = t.parent === null ? undefined : this.byId.get(t.parent);
    const lines = [
      el('div', { class: 'v' }, this.labelOf(n)),
      t.agentType !== null || t.background
        ? d([t.agentType, t.background && 'in the background'].filter((v) => typeof v === 'string').join(' · '))
        : null,
      d(`${when} · wall ${fmt(s.wall)} · active ${fmt(s.active)}`),
      d(`${s.calls} model calls · ${s.toolCalls} tool calls${s.out === null ? '' : ` · ${kTok(s.out)} output tokens`}`),
      this.launchLine(r, parent),
    ];
    if (x >= LABEL_W && n.start !== null) {
      const at = this.map.toReal(this.scale.d(x));
      const seg = t.segments.find(([a, b]) => at >= a && at < b);
      if (seg !== undefined) lines.push(d(`At ${stamp(at)}: ${bucketLabel(seg[2])}`));
    }
    this.tipAt(
      e,
      lines.filter((l) => l !== null),
    );
  }
}
