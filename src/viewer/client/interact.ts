import type { ViewSpan } from '../../view/types.js';
import type { App } from './app.js';
import { bucketLabel, catOfBucket, catOfSpan, failed, spanDetail, spanName } from './categories.js';
import { el, nodes, query, type Child } from './dom.js';
import { fmt, kTok, oneLine } from './format.js';
import { hitTest, LABEL_W, sameHit, type Hit } from './layout.js';

// What the timeline does with the pointer, the wheel, and the keyboard: hover tooltips, clicks
// that select, panning and zooming, the axis brush, and the overview's window.

function tipRow(app: App, cat: string | null, value: string, name: string): HTMLDivElement {
  return el(
    'div',
    { class: 'row' },
    cat ? app.key(cat, true) : null,
    el('span', { class: 'v' }, value),
    el('span', { class: 'n' }, name),
  );
}

/**
 * A span's output tokens, for its tooltip. Kept from the prototype for parity: it reads `out` of
 * every span, so a tool call's output text (its `out`) shows as if it were a count, as kTok reads a
 * string: ` · <output> output tokens`.
 */
function outputTokens(s: ViewSpan): string {
  if (s.t === 'm') return s.out != null ? ` · ${kTok(s.out)} output tokens` : '';
  const n = Number(s.out);
  return ` · ${n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : s.out} output tokens`;
}

/** Says what a turn's kind is, for the tooltip. */
function turnKindTip(kind: string): string {
  return kind === 'you' ? 'your prompt' : kind === 'task' ? 'background task reported' : kind;
}

/** Shows the tooltip for what the pointer at (cx, cy) is on, or hides it. */
function showTip(app: App, h: Hit | null, cx: number, cy: number): void {
  const tip = app.els.tip;
  const stamp = app.stamp;
  let kids: Child[];
  if (!h) {
    tip.hidden = true;
    return;
  }
  if (h.type === 'span') {
    const s = h.l.spans[h.i];
    if (!s) return;
    kids = [
      tipRow(app, catOfSpan(s), s.ms == null ? 'unfinished' : fmt(s.ms), spanName(s)),
      el('div', { class: 'd' }, oneLine(spanDetail(s), 220)),
      failed(s) ? el('div', { class: 'fail' }, s.t === 't' && s.intr ? '✗ Interrupted' : '✗ Failed') : null,
      s.t === 't' && s.async
        ? el(
            'div',
            { class: 'd' },
            s.bgEnd ? `Ran in the background until ${stamp(s.bgEnd)} (${fmt(s.bgEnd - s.s)})` : 'Ran in the background',
          )
        : null,
      el(
        'div',
        { class: 'muted' },
        `${stamp(s.s)} → ${stamp(s.e)}${s.turn ? ` · turn #${s.turn}` : ''}${outputTokens(s)}`,
      ),
    ];
  } else if (h.type === 'seg') {
    const g = h.l.seg[h.i];
    if (!g) return;
    const [s, e, b] = g;
    kids = [
      tipRow(app, catOfBucket(b, app.data.toolCategories), fmt(e - s), bucketLabel(b)),
      el('div', { class: 'muted' }, `${stamp(s)} → ${stamp(e)}`),
    ];
  } else if (h.type === 'turn') {
    const t = h.l.turns[h.i];
    if (!t) return;
    kids = [
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'v' }, fmt(t.active)),
        el('span', { class: 'n' }, `Turn #${t.n} · ${turnKindTip(t.kind)}`),
      ),
      el('div', { class: 'd' }, oneLine(t.text, 240)),
      el(
        'div',
        { class: 'muted' },
        `${stamp(t.ts)} → ${stamp(t.end)} · ${t.calls} model calls · ${t.tools} tool calls`,
      ),
    ];
  } else if (h.type === 'label') {
    const l = h.l;
    const st = l.stats;
    kids = [
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'v' }, fmt(st.active)),
        el('span', { class: 'n' }, `${l.phase ? `${l.phase} · ` : ''}${l.label}`),
      ),
      el(
        'div',
        { class: 'muted' },
        `${stamp(l.start)} → ${stamp(l.end)} · ${fmt(st.wall)} wall · click to show its trace`,
      ),
    ];
  } else if (h.type === 'group') {
    kids = [
      el('div', { class: 'n' }, h.g.label),
      el('div', { class: 'muted' }, app.collapsed.has(h.g.id) ? 'Click to expand' : 'Click to collapse'),
    ];
  } else {
    tip.hidden = true;
    return;
  }
  tip.replaceChildren(...nodes(kids));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = cx + 14;
  let y = cy + 14;
  if (x + r.width > window.innerWidth - 8) x = cx - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = cy - r.height - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

/** What a click on the lanes does: collapses a group, or shows the lane and selects what it hit. */
function onClick(app: App, h: Hit | null): void {
  if (!h) return;
  if (h.type === 'group') {
    app.toggleGroup(h.g);
    return;
  }
  if (h.l !== app.cur) app.setLane(h.l);
  if (h.type === 'span' || h.type === 'seg' || h.type === 'turn') app.select(h, { pan: false });
  else app.select(null);
}

/** Zooms to what a double click hit: a span (with its background task), a stretch, a turn, or a lane. */
function onDoubleClick(app: App, h: Hit | null): void {
  if (!h) return;
  if (h.type === 'span') {
    const s = h.l.spans[h.i];
    if (s) app.zoomToReal(s.s, Math.max(s.e, (s.t === 't' ? s.bgEnd : null) ?? 0));
  } else if (h.type === 'seg') {
    const g = h.l.seg[h.i];
    if (g) app.zoomToReal(g[0], g[1]);
  } else if (h.type === 'turn') {
    const t = h.l.turns[h.i];
    if (t) app.zoomToReal(t.ts, t.end);
  } else if (h.type === 'label' || h.type === 'lane') app.zoomToReal(h.l.start ?? NaN, h.l.end ?? NaN);
}

export function bindTimeline(app: App): void {
  const { lanes: lc, scroll: sc, axis: ax, overview: ov, tip } = app.els;
  const pos = (e: MouseEvent): { px: number; py: number } => {
    const r = lc.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top + sc.scrollTop };
  };
  let drag: { x: number; v0: number; v1: number; moved: boolean; px: number } | null = null;
  sc.addEventListener('scroll', () => {
    app.requestDraw();
  });
  lc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const { px } = pos(e);
    drag = { x: e.clientX, v0: app.view.v0, v1: app.view.v1, moved: false, px };
    lc.setPointerCapture(e.pointerId);
  });
  lc.addEventListener('pointermove', (e) => {
    const { px, py } = pos(e);
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved && drag.px > LABEL_W) {
        const dd = (dx / app.plotW) * (drag.v1 - drag.v0);
        tip.hidden = true;
        lc.style.cursor = 'grabbing';
        app.setView({ v0: drag.v0 - dd, v1: drag.v1 - dd }, true);
      }
      return;
    }
    const h = hitTest(app.layout, app.scale, px, py);
    if (!sameHit(h, app.hover)) {
      app.hover = h;
      app.requestDraw();
    }
    lc.style.cursor = h && h.type !== 'lane' ? 'pointer' : 'grab';
    showTip(app, h, e.clientX, e.clientY);
  });
  lc.addEventListener('pointerleave', () => {
    app.hover = null;
    tip.hidden = true;
    app.requestDraw();
  });
  lc.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    lc.style.cursor = 'grab';
    if (!d || d.moved) return;
    const { px, py } = pos(e);
    onClick(app, hitTest(app.layout, app.scale, px, py));
  });
  lc.addEventListener('dblclick', (e) => {
    const { px, py } = pos(e);
    onDoubleClick(app, hitTest(app.layout, app.scale, px, py));
  });
  const onWheel = (e: WheelEvent): void => {
    const r = lc.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      app.zoomAt(Math.max(LABEL_W, px), Math.exp(e.deltaY * 0.0025));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      app.pan(((e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) / app.plotW) * (app.view.v1 - app.view.v0));
    }
  };
  lc.addEventListener('wheel', onWheel, { passive: false });
  ax.addEventListener('wheel', onWheel, { passive: false });

  // drag across the axis to zoom to a range
  ax.addEventListener('pointerdown', (e) => {
    const x = e.clientX - ax.getBoundingClientRect().left;
    if (x < LABEL_W) return;
    app.brush = { a: x, b: x };
    ax.setPointerCapture(e.pointerId);
  });
  ax.addEventListener('pointermove', (e) => {
    if (!app.brush) return;
    app.brush.b = Math.max(LABEL_W, Math.min(LABEL_W + app.plotW, e.clientX - ax.getBoundingClientRect().left));
    app.requestDraw();
  });
  ax.addEventListener('pointerup', () => {
    const brush = app.brush;
    if (!brush) return;
    const a = Math.min(brush.a, brush.b);
    const b = Math.max(brush.a, brush.b);
    app.brush = null;
    if (b - a > 4) {
      const scale = app.scale;
      app.setView({ v0: scale.d(a), v1: scale.d(b) }, true);
    } else app.requestDraw();
  });

  // overview: drag the window, or click to center it
  let ovDrag: { d: number; v0: number; v1: number } | null = null;
  const ovD = (e: MouseEvent): number =>
    ((e.clientX - ov.getBoundingClientRect().left - LABEL_W) / app.plotW) * app.map.total;
  ov.addEventListener('pointerdown', (e) => {
    const d = ovD(e);
    if (d < app.view.v0 || d > app.view.v1) app.pan(d - (app.view.v0 + app.view.v1) / 2);
    ovDrag = { d: ovD(e), v0: app.view.v0, v1: app.view.v1 };
    ov.setPointerCapture(e.pointerId);
    ov.style.cursor = 'grabbing';
  });
  ov.addEventListener('pointermove', (e) => {
    if (!ovDrag) return;
    const dd = ovD(e) - ovDrag.d;
    app.setView({ v0: ovDrag.v0 + dd, v1: ovDrag.v1 + dd }, true);
  });
  ov.addEventListener('pointerup', () => {
    ovDrag = null;
    ov.style.cursor = 'grab';
  });

  query('#fit', HTMLButtonElement).addEventListener('click', () => {
    app.fit();
  });
  query('#zin', HTMLButtonElement).addEventListener('click', () => {
    app.zoomAt(LABEL_W + app.plotW / 2, 0.6);
  });
  query('#zout', HTMLButtonElement).addEventListener('click', () => {
    app.zoomAt(LABEL_W + app.plotW / 2, 1 / 0.6);
  });
  app.els.compress.addEventListener('change', () => {
    const r0 = app.map.toReal(app.view.v0);
    const r1 = app.map.toReal(app.view.v1);
    app.buildMapping();
    app.setView({ v0: app.map.toDisp(r0), v1: app.map.toDisp(r1) }, true);
  });

  document.addEventListener('keydown', (e) => {
    if (
      !(e.target instanceof Element) ||
      e.target.matches('input, textarea, select') ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey
    )
      return;
    const mid = LABEL_W + app.plotW / 2;
    switch (e.key) {
      case 'w':
        app.zoomAt(mid, 0.7);
        break;
      case 's':
        app.zoomAt(mid, 1 / 0.7);
        break;
      case 'a':
        app.pan(-(app.view.v1 - app.view.v0) * 0.2);
        break;
      case 'd':
        app.pan((app.view.v1 - app.view.v0) * 0.2);
        break;
      case 'f':
        app.fit();
        break;
      case 'j':
        app.step(1);
        break;
      case 'k':
        app.step(-1);
        break;
      case 'Escape':
        app.select(null);
        break;
      case '/':
        app.els.q.focus();
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  window.addEventListener('resize', () => {
    app.sizeCanvases();
    app.requestDraw();
  });
}
