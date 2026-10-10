import type { ViewGroup } from '../../view/types.js';
import type { App } from './app.js';
import { catOfBucket, catOfSpan, failed, isIdle } from './categories.js';
import { color } from './colors.js';
import { dayStr, fmt, kTok, oneLine, pct } from './format.js';
import { GAP, LABEL_W, PAD_T, ROW_H, STATE_H, type Lane, type LayoutItem } from './layout.js';
import { fitText, ticks, type Tick } from './ticks.js';

// The timeline's three canvases: the time axis, the lanes, and the overview.

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Draws the axis, the lanes, and the overview. */
export function drawAll(app: App): void {
  const tk = ticks(app.scale, app.multiDay);
  drawAxis(app, tk);
  drawLanes(app, tk);
  drawOverview(app);
}

function fitted(ctx: CanvasRenderingContext2D, text: string, w: number): string {
  return fitText((t) => ctx.measureText(t).width, text, w);
}

function drawAxis(app: App, tk: readonly Tick[]): void {
  const ctx = app.actx;
  const { cssW, plotW, view, brush } = app;
  const scale = app.scale;
  ctx.clearRect(0, 0, cssW, 28);
  ctx.font = `11px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color('text-secondary');
  const startLabel = app.multiDay ? dayStr(app.map.toReal(Math.max(view.v0, 0))) : dayStr(app.T0);
  ctx.fillText(startLabel, 12, 14);
  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, 0, plotW, 28);
  ctx.clip();
  for (const p of app.map.pieces) {
    if (!p.gap || p.d1 < view.v0 || p.d0 > view.v1) continue;
    const x0 = scale.x(p.d0);
    const x1 = scale.x(p.d1);
    ctx.fillStyle = color('gap-band');
    ctx.fillRect(x0, 0, x1 - x0, 28);
    const label = `⋯ ${fmt(p.r1 - p.r0)}`;
    ctx.fillStyle = color('muted');
    const w = ctx.measureText(label).width;
    if (w + 6 < x1 - x0) ctx.fillText(label, (x0 + x1) / 2 - w / 2, 14);
  }
  for (const t of tk) {
    ctx.fillStyle = color('axis');
    ctx.fillRect(Math.round(t.x), 22, 1, 6);
    if (t.x + 4 + ctx.measureText(t.label).width > LABEL_W + plotW) continue;
    ctx.fillStyle = color('text-secondary');
    ctx.fillText(t.label, t.x + 4, 12);
  }
  if (brush) {
    ctx.fillStyle = color('wash');
    ctx.fillRect(Math.min(brush.a, brush.b), 0, Math.abs(brush.b - brush.a), 28);
    ctx.fillStyle = color('text-primary');
    ctx.fillRect(Math.min(brush.a, brush.b), 0, 1, 28);
    ctx.fillRect(Math.max(brush.a, brush.b), 0, 1, 28);
  }
  ctx.restore();
}

function drawLanes(app: App, tk: readonly Tick[]): void {
  const ctx = app.lctx;
  const { cssW, viewH, plotW, view } = app;
  const scale = app.scale;
  const top = app.els.scroll.scrollTop;
  ctx.clearRect(0, 0, cssW, viewH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, 0, plotW, viewH);
  ctx.clip();
  for (const p of app.map.pieces) {
    if (!p.gap || p.d1 < view.v0 || p.d0 > view.v1) continue;
    ctx.fillStyle = color('gap-band');
    ctx.fillRect(scale.x(p.d0), 0, scale.x(p.d1) - scale.x(p.d0), viewH);
  }
  ctx.fillStyle = color('grid');
  for (const t of tk) ctx.fillRect(Math.round(t.x), 0, 1, viewH);
  ctx.restore();
  for (const it of app.layout) {
    const y = it.y - top;
    if (y + it.h < 0 || y > viewH) continue;
    if (it.type === 'group') drawGroup(app, ctx, it, y);
    else drawLane(app, ctx, it.l, y);
  }
}

/** A group's summary: its status, duration, agents, tokens, and tool calls, as far as it has them. */
export function groupMeta(g: ViewGroup, n: number): string {
  return [
    g.status,
    g.ms != null ? fmt(g.ms) : null,
    `${n} agent${n === 1 ? '' : 's'}`,
    g.tokens != null ? `${kTok(g.tokens)} tokens` : null,
    g.toolCalls != null ? `${g.toolCalls} tool calls` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function drawGroup(
  app: App,
  ctx: CanvasRenderingContext2D,
  it: Extract<LayoutItem, { type: 'group' }>,
  y: number,
): void {
  ctx.fillStyle = color('page');
  ctx.fillRect(0, y, app.cssW, it.h);
  ctx.fillStyle = color('grid');
  ctx.fillRect(0, y, app.cssW, 1);
  ctx.textBaseline = 'middle';
  ctx.font = `600 12px ${FONT}`;
  ctx.fillStyle = color('text-primary');
  const head = `${app.collapsed.has(it.g.id) ? '▸' : '▾'}  ${it.g.label}${it.g.kind !== undefined ? `  ${it.g.id}` : ''}`;
  ctx.fillText(head, 12, y + it.h / 2);
  const w = ctx.measureText(head).width;
  ctx.font = `12px ${FONT}`;
  ctx.fillStyle = color('text-secondary');
  ctx.fillText(groupMeta(it.g, it.n), 12 + w + 12, y + it.h / 2);
}

function drawLane(app: App, ctx: CanvasRenderingContext2D, l: Lane, y: number): void {
  const { cssW, plotW, hover, sel } = app;
  const scale = app.scale;
  const isCur = l === app.cur;
  if (isCur) {
    ctx.fillStyle = color('wash');
    ctx.fillRect(0, y, cssW, l.height);
  } else if (hover?.type === 'label' && hover.l === l) {
    ctx.fillStyle = color('hover');
    ctx.fillRect(0, y, LABEL_W, l.height);
  }
  ctx.fillStyle = color('grid');
  ctx.fillRect(0, y + l.height - 1, cssW, 1);
  // label
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${isCur ? '600 ' : ''}12px ${FONT}`;
  ctx.fillStyle = color('text-primary');
  const name = `${l.nested ? '↳ ' : ''}${l.phase ? `${l.phase} · ` : ''}${l.label}`;
  ctx.fillText(fitted(ctx, name, LABEL_W - 24), 12, y + 20);
  ctx.font = `11px ${FONT}`;
  ctx.fillStyle = color('text-secondary');
  const st = l.stats;
  ctx.fillText(
    fitted(ctx, `${fmt(st.active)} active · ${pct(st.model, st.active)} model · ${fmt(st.wall)} wall`, LABEL_W - 24),
    12,
    y + 35,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, y, plotW, l.height);
  ctx.clip();
  const ys = y + PAD_T;
  const left = LABEL_W - 2;
  const right = LABEL_W + plotW + 2;
  // state track
  l.seg.forEach(([s, e, b], i) => {
    const x0 = scale.xt(s);
    const x1 = scale.xt(e);
    if (x1 < left || x0 > right) return;
    ctx.fillStyle = color(catOfBucket(b, app.data.toolCategories));
    ctx.fillRect(x0, ys, Math.max(1, x1 - x0), STATE_H);
    if (hover?.type === 'seg' && hover.l === l && hover.i === i) {
      ctx.fillStyle = color('lift');
      ctx.fillRect(x0, ys, Math.max(1, x1 - x0), STATE_H);
    }
    if (sel?.type === 'seg' && sel.l === l && sel.i === i) ring(ctx, x0, ys, Math.max(1, x1 - x0), STATE_H);
  });
  // spans
  const rowsY = ys + STATE_H + GAP;
  ctx.font = `11px ${FONT}`;
  ctx.textBaseline = 'middle';
  l.spans.forEach((s, i) => {
    const y0 = rowsY + s.row * ROW_H + 1;
    const h = ROW_H - 4;
    let x0 = scale.xt(s.s);
    const x1 = scale.xt(s.e);
    const fill = color(catOfSpan(s));
    if (s.t === 't' && s.async && s.bgEnd !== null && s.bgEnd !== 0 && s.bgEnd > s.e) {
      const xe = scale.xt(s.bgEnd);
      if (xe >= left && x1 <= right) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = fill;
        ctx.fillRect(x1, y0 + h / 2 - 1, xe - x1, 2);
        ctx.fillRect(xe - 1, y0 + 2, 2, h - 4);
        ctx.globalAlpha = 1;
      }
    }
    if (x1 < left || x0 > right) return;
    let w = x1 - x0;
    if (w < 1) {
      x0 -= (1 - w) / 2;
      w = 1;
    }
    const inset = w > 4 ? 1 : 0;
    ctx.fillStyle = fill;
    roundRect(ctx, x0 + inset, y0, w - 2 * inset, h, w > 6 ? 2 : 0);
    ctx.fill();
    if (hover?.type === 'span' && hover.l === l && hover.i === i) {
      ctx.fillStyle = color('lift');
      roundRect(ctx, x0 + inset, y0, w - 2 * inset, h, w > 6 ? 2 : 0);
      ctx.fill();
    }
    if (failed(s)) {
      ctx.fillStyle = color('critical');
      ctx.fillRect(x0 + inset, y0 - 1, Math.max(2, w - 2 * inset), 3);
    }
    if (w > 34) {
      const tx = Math.max(x0, LABEL_W) + 4;
      const avail = Math.min(x1, LABEL_W + plotW) - tx - 4;
      const what =
        s.t === 'm'
          ? `model${s.out != null ? ` ${kTok(s.out)}` : ''}${s.text ? ` · ${oneLine(s.text, 80)}` : ''}`
          : `${s.name} ${s.desc || s.pv}`;
      const label = fitted(ctx, `${failed(s) ? '✗ ' : ''}${what}`, avail);
      if (label) {
        ctx.fillStyle = color('on-fill');
        ctx.fillText(label, tx, y0 + h / 2 + 0.5);
      }
    }
    if (sel?.type === 'span' && sel.l === l && sel.i === i) ring(ctx, x0, y0, w, h);
  });
  // turn markers
  ctx.font = `10px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  let lastX = -Infinity;
  l.turns.forEach((t, i) => {
    const x = scale.xt(t.ts);
    if (x < left || x > right) return;
    const isSel = sel?.type === 'turn' && sel.l === l && sel.i === i;
    const isHover = hover?.type === 'turn' && hover.l === l && hover.i === i;
    ctx.fillStyle = isSel || isHover ? color('text-primary') : color('text-secondary');
    ctx.globalAlpha = isSel || isHover ? 1 : 0.55;
    ctx.fillRect(Math.round(x), y + 3, 1, l.height - 6);
    ctx.globalAlpha = 1;
    if (x - lastX > 26 || isSel || isHover) {
      ctx.fillText(`#${t.n}`, x + 3, y + 11);
      lastX = x;
    }
  });
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (r > 0) ctx.roundRect(x, y, Math.max(0, w), h, r);
  else ctx.rect(x, y, Math.max(0, w), h);
}

/** The selection's outline. */
function ring(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.strokeStyle = color('text-primary');
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 1.5, y - 1.5, Math.max(1, w) + 3, h + 3);
}

function drawOverview(app: App): void {
  const ctx = app.octx;
  const { cssW, plotW, view, map } = app;
  ctx.clearRect(0, 0, cssW, 30);
  ctx.font = `11px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color('text-secondary');
  ctx.fillText('Overview', 12, 15);
  const total = map.total;
  const OX = (d: number): number => LABEL_W + (d / total) * plotW;
  for (const [s, e, b] of app.main.seg) {
    const x0 = OX(map.toDisp(s));
    const x1 = OX(map.toDisp(e));
    ctx.fillStyle = color(catOfBucket(b, app.data.toolCategories));
    ctx.fillRect(x0, 6, Math.max(0.5, x1 - x0), 7);
  }
  ctx.fillStyle = color('text-secondary');
  ctx.globalAlpha = 0.22;
  for (const l of app.lanes.slice(1))
    for (const [s, e, b] of l.seg)
      if (!isIdle(b)) ctx.fillRect(OX(map.toDisp(s)), 17, Math.max(0.5, OX(map.toDisp(e)) - OX(map.toDisp(s))), 7);
  ctx.globalAlpha = 1;
  const a = Math.max(LABEL_W, OX(view.v0));
  const b = Math.min(LABEL_W + plotW, OX(view.v1));
  ctx.fillStyle = color('wash');
  ctx.fillRect(a, 1, Math.max(2, b - a), 28);
  ctx.strokeStyle = color('text-primary');
  ctx.lineWidth = 1;
  ctx.strokeRect(a + 0.5, 1.5, Math.max(2, b - a) - 1, 27);
}
