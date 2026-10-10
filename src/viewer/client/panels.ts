import type { Bucket, ViewTurn } from '../../view/types.js';
import type { App, Tab } from './app.js';
import { bucketLabel, catOfBucket, catOfSpan, failed, isIdle, spanDetail, spanName, type Cat } from './categories.js';
import { color } from './colors.js';
import { byId, el, present, query, queryAll, type Child } from './dom.js';
import { fmt, kTok, oneLine, pct } from './format.js';
import type { Lane, LaneSpan } from './layout.js';
import { isTraceKind, nextSort, traceRows, type TraceSort } from './trace.js';

// The panels below the timeline: the stats tiles, the Trace, Turns, Breakdown, and Agents tabs, and
// the detail pane of the selection or the current lane.

const TABS: readonly Tab[] = ['trace', 'turns', 'breakdown', 'agents'];

function isTab(value: string | undefined): value is Tab {
  return TABS.some((t) => t === value);
}

/** A lane's name: its phase, then its label. */
function laneName(l: Lane): string {
  return `${l.phase ? `${l.phase} · ` : ''}${l.label}`;
}

export function renderStats(app: App): void {
  const { cur, stamp } = app;
  const st = cur.stats;
  const tile = (k: string, v: string, s: string | null) =>
    el(
      'div',
      { class: 'tile' },
      el('div', { class: 'k' }, k),
      el('div', { class: 'v' }, v),
      s ? el('div', { class: 's' }, s) : null,
    );
  byId('stats', HTMLElement).replaceChildren(
    tile('Wall clock', fmt(st.wall), `${stamp(cur.start)} → ${stamp(cur.end)}`),
    tile('Active', fmt(st.active), `${pct(st.active, st.wall)} of wall`),
    tile('Model', fmt(st.model), `${pct(st.model, st.active)} of active`),
    tile('Tools', fmt(st.tools), `${pct(st.tools, st.active)} of active`),
    tile('Waiting on you', fmt(st.you), cur.id === 'main' ? 'between turns and on questions' : null),
    tile('Model calls', String(st.calls), st.models.join(', ') || null),
    tile('Tool calls', String(st.toolCalls), `${cur.spans.filter(failed).length} failed or interrupted`),
    tile(
      'Output tokens',
      st.out == null ? 'not recorded' : kTok(st.out),
      st.out == null
        ? 'subagent transcripts omit usage'
        : `${kTok(st.cacheRead)} cache read · ${kTok(st.cacheWrite)} written`,
    ),
  );
}

export function bindPanels(app: App): void {
  const buttons = queryAll('.tabs button', HTMLButtonElement);
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const tab = b.dataset['tab'];
      if (!isTab(tab)) return;
      app.activeTab = tab;
      for (const x of queryAll('.tabs button', HTMLButtonElement)) x.classList.toggle('on', x === b);
      for (const t of TABS) byId(`tab-${t}`, HTMLDivElement).hidden = t !== app.activeTab;
      renderPanels(app);
    });
  }
  app.els.q.addEventListener('input', () => {
    app.traceLimit = 500;
    renderTrace(app);
  });
  app.els.kind.addEventListener('change', () => {
    app.traceLimit = 500;
    renderTrace(app);
  });
  app.els.inview.addEventListener('change', () => {
    renderTrace(app);
  });
  query('.tabs button[data-tab="agents"]', HTMLButtonElement).hidden = app.lanes.length < 2;
}

export function renderPanels(app: App): void {
  if (app.activeTab === 'trace') renderTrace(app);
  else if (app.activeTab === 'turns') renderTurns(app);
  else if (app.activeTab === 'breakdown') renderBreakdown(app);
  else renderAgents(app);
}

/** How a turn's kind reads in the trace. */
function turnKindTrace(kind: ViewTurn['kind']): string {
  return kind === 'you' ? 'you' : kind === 'task' ? 'background task reported' : kind;
}

export function renderTrace(app: App): void {
  if (app.activeTab !== 'trace') return;
  const { els, stamp } = app;
  const cur = app.cur;
  const kind = els.kind.value;
  const rows = traceRows(cur, {
    q: els.q.value.trim().toLowerCase(),
    kind: isTraceKind(kind) ? kind : 'all',
    inview: els.inview.checked,
    r0: app.map.toReal(app.view.v0),
    r1: app.map.toReal(app.view.v1),
    sort: app.traceSort,
  });
  const spansShown = rows.filter((r) => r.kind === 'span');
  const maxMs = Math.max(1, ...spansShown.map((r) => r.ms));
  els.count.textContent = `${spansShown.length} of ${cur.spans.length} spans`;
  const sortHead = (label: string, by: TraceSort['by'], cls?: string) =>
    el(
      'th',
      {
        class: `sortable ${cls ?? ''}`,
        onclick: () => {
          app.traceSort = nextSort(app.traceSort, by);
          renderTrace(app);
        },
      },
      `${label}${app.traceSort.by === by ? (app.traceSort.dir > 0 ? ' ▲' : ' ▼') : ''}`,
    );
  const body = el('tbody');
  for (const r of rows.slice(0, app.traceLimit)) {
    if (r.kind === 'turn') {
      const t = cur.turns[r.i];
      if (!t) continue;
      body.append(
        el(
          'tr',
          {
            class: 'sep',
            'data-turn': r.i,
            onclick: () => {
              app.select({ type: 'turn', l: app.cur, i: r.i });
            },
          },
          el(
            'td',
            { colspan: 6 },
            `#${t.n} · ${stamp(t.ts)} · ${turnKindTrace(t.kind)}: ${oneLine(t.text, 160)}  `,
            el('span', { class: 'muted' }, `${fmt(t.active)} active`),
          ),
        ),
      );
      continue;
    }
    if (r.kind === 'idle') {
      const g = cur.seg[r.i];
      if (!g) continue;
      const [s, e, b] = g;
      body.append(
        el(
          'tr',
          {
            class: 'row idle',
            'data-seg': r.i,
            onclick: () => {
              app.select({ type: 'seg', l: app.cur, i: r.i });
            },
          },
          el('td', { class: 'time' }, stamp(s)),
          el('td', { class: 'num' }, fmt(e - s)),
          el('td'),
          el('td', {}, app.key(catOfBucket(b, app.data.toolCategories)), ' ', bucketLabel(b)),
          el('td', { class: 'wide' }, ''),
          el('td'),
        ),
      );
      continue;
    }
    const s = r.s;
    const cat = catOfSpan(s);
    body.append(
      el(
        'tr',
        {
          class: 'row',
          'data-span': r.i,
          onclick: () => {
            app.select({ type: 'span', l: app.cur, i: r.i });
          },
        },
        el('td', { class: 'time' }, stamp(s.s)),
        el('td', { class: 'num' }, s.ms == null ? '…' : fmt(s.ms)),
        el(
          'td',
          {},
          el(
            'span',
            { class: 'track' },
            el('span', {
              class: 'bar',
              style: `width:${Math.max(1, Math.round((72 * (s.ms ?? 0)) / maxMs))}px;background:${color(cat)}`,
            }),
          ),
        ),
        el(
          'td',
          {},
          app.key(cat),
          ' ',
          spanName(s),
          failed(s) ? el('span', { class: 'fail' }, s.t === 't' && s.intr ? '  ✗ interrupted' : '  ✗ failed') : null,
          s.t === 't' && s.async ? el('span', { class: 'muted' }, '  async') : null,
        ),
        el('td', { class: 'wide', title: spanDetail(s) }, oneLine(spanDetail(s), 240)),
        el('td', { class: 'num muted' }, s.turn ? `#${s.turn}` : ''),
      ),
    );
  }
  const table = el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        sortHead('Start', 'time'),
        sortHead('Duration', 'dur', 'num'),
        el('th', { text: '' }),
        el('th', { text: 'What' }),
        el('th', { text: 'Detail' }),
        el('th', { class: 'num', text: 'Turn' }),
      ),
    ),
    body,
  );
  const kids: Node[] = [table];
  if (rows.length > app.traceLimit)
    kids.push(
      el(
        'button',
        {
          class: 'more',
          type: 'button',
          onclick: () => {
            app.traceLimit += 1000;
            renderTrace(app);
          },
        },
        `Show ${Math.min(1000, rows.length - app.traceLimit)} more of ${rows.length - app.traceLimit}`,
      ),
    );
  els.traceWrap.replaceChildren(...kids);
  markSelectedRow(app, false);
}

/** Marks the selection's row of the trace, scrolling it into view unless `scroll` is false. */
export function markSelectedRow(app: App, scroll = true): void {
  const wrap = app.els.traceWrap;
  for (const tr of wrap.querySelectorAll('tr.sel')) tr.classList.remove('sel');
  const sel = app.sel;
  if (sel?.l !== app.cur || app.activeTab !== 'trace') return;
  const attr = sel.type === 'span' ? 'data-span' : sel.type === 'seg' ? 'data-seg' : 'data-turn';
  const tr = wrap.querySelector(`tr[${attr}="${sel.i}"]`);
  if (tr) {
    tr.classList.add('sel');
    if (scroll) tr.scrollIntoView({ block: 'nearest' });
  }
}

/** A bar of where active time went: the model, the shell, other tools, and the person. */
function composition(app: App, b: readonly (readonly [Bucket, number])[], max: number, width = 120): HTMLSpanElement {
  const keys: readonly Cat[] = ['model', 'shell', 'tool', 'you'];
  const parts = keys.map(
    (c) =>
      [
        c,
        b.filter(([k]) => !isIdle(k) && catOfBucket(k, app.data.toolCategories) === c).reduce((a, [, v]) => a + v, 0),
      ] as const,
  );
  return el(
    'span',
    { class: 'track', style: `width:${width}px` },
    parts
      .filter(([, v]) => v > 0)
      .map(([c, v]) =>
        el('span', {
          class: 'bar',
          style: `width:${Math.max(1, Math.round((width * v) / Math.max(1, max)))}px;background:${color(c)}`,
          title: `${app.cats.find((x) => x.key === c)?.label ?? c} ${fmt(v)}`,
        }),
      ),
  );
}

function renderTurns(app: App): void {
  const { stamp } = app;
  const l = app.cur;
  const sel = app.sel;
  const max = Math.max(1, ...l.turns.map((t) => t.active));
  const rows = l.turns.map((t, i) => {
    const m = t.b.find(([k]) => k === 'model')?.[1] ?? 0;
    const tools = t.b.filter(([k]) => k.startsWith('tool:')).reduce((a, [, v]) => a + v, 0);
    return el(
      'tr',
      {
        class: `row${sel?.l === l && sel.type === 'turn' && sel.i === i ? ' sel' : ''}`,
        onclick: () => {
          app.select({ type: 'turn', l, i });
        },
      },
      el('td', { class: 'num' }, `#${t.n}`),
      el('td', { class: 'time' }, stamp(t.ts)),
      el('td', {}, t.kind),
      el('td', { class: 'num' }, fmt(t.active)),
      el('td', {}, composition(app, t.b, max)),
      el('td', { class: 'num' }, fmt(m)),
      el('td', { class: 'num' }, fmt(tools)),
      el('td', { class: 'num' }, t.calls),
      el('td', { class: 'num' }, t.tools),
      el('td', { class: 'wide', title: t.text }, oneLine(t.text, 200)),
    );
  });
  const heads = ['#', 'Start', 'By', 'Active', 'Where it went', 'Model', 'Tools', 'Calls', 'Tool calls', 'Prompt'];
  byId('tab-turns', HTMLDivElement).replaceChildren(
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el('tr', {}, ...heads.map((h, i) => el('th', { class: [0, 3, 5, 6, 7, 8].includes(i) ? 'num' : '' }, h))),
        ),
        el('tbody', {}, rows),
      ),
    ),
    el(
      'p',
      { class: 'muted' },
      'Active time only; idle time sits between turns. Click a turn to zoom the timeline to it.',
    ),
  );
}

interface BarRow {
  readonly label: string;
  readonly cat: Cat;
  readonly ms: number;
  readonly idle: boolean;
}

/** Horizontal bars of time by bucket, the idle ones after a divider; shares are of `total`. */
function hbars(app: App, rows: readonly BarRow[], total: number): HTMLDivElement {
  const max = Math.max(
    1,
    ...rows.filter((r) => !r.idle).map((r) => r.ms),
    ...rows.filter((r) => r.idle).map((r) => r.ms),
  );
  const kids: HTMLElement[] = [];
  let idleShown = false;
  for (const r of rows) {
    if (r.idle && !idleShown) {
      kids.push(el('div', { class: 'div' }, 'Idle'));
      idleShown = true;
    }
    kids.push(
      el('div', { class: 'lab', title: r.label }, app.key(r.cat), ' ', r.label),
      el(
        'div',
        { class: 'barcell' },
        el('span', {
          class: 'bar',
          style: `display:block;width:${Math.max(0.3, (100 * r.ms) / max)}%;background:${color(r.cat)}`,
        }),
      ),
      el('div', { class: 'val' }, fmt(r.ms)),
      el('div', { class: 'shr' }, r.idle ? '' : pct(r.ms, total)),
    );
  }
  return el('div', { class: 'hbars' }, kids);
}

function renderBreakdown(app: App): void {
  const l = app.cur;
  const st = l.stats;
  const categories = app.data.toolCategories;
  const rows: BarRow[] = l.buckets.map(([b, ms]) => ({
    label: bucketLabel(b),
    cat: catOfBucket(b, categories),
    ms,
    idle: isIdle(b),
  }));
  rows.sort((a, b) => Number(a.idle) - Number(b.idle) || b.ms - a.ms);
  const spanList = (list: readonly { s: LaneSpan; i: number }[], label: (s: LaneSpan) => string) =>
    el(
      'ul',
      { class: 'linklist' },
      list.map(({ s, i }) =>
        el(
          'li',
          {
            onclick: () => {
              app.select({ type: 'span', l, i });
            },
          },
          app.key(catOfSpan(s)),
          el('span', {}, label(s)),
          el('span', { class: 'muted' }, oneLine(spanDetail(s), 90)),
          el('span', { class: 'num' }, fmt(s.ms)),
        ),
      ),
    );
  const indexed = l.spans.map((s, i) => ({ s, i }));
  const slowTools = indexed
    .filter((x) => x.s.t === 't' && x.s.ms != null)
    .sort((a, b) => (b.s.ms ?? 0) - (a.s.ms ?? 0))
    .slice(0, 12);
  const slowModel = indexed
    .filter((x) => x.s.t === 'm')
    .sort((a, b) => (b.s.ms ?? 0) - (a.s.ms ?? 0))
    .slice(0, 12);
  const shellMax = Math.max(1, ...l.bash.map((b) => b[1]));
  // The prototype passes null for a missing section, which replaceChildren writes as the text
  // "null": kept for parity (MISSING), so a lane without shell calls or compactions shows "nullnull".
  const shell: Child[] = l.bash.length
    ? [
        el('h3', {}, `${app.data.shellLabel} by command`),
        el(
          'div',
          { class: 'table-wrap', style: 'max-height:320px' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { text: 'Command' }),
                el('th', { class: 'num', text: 'Time' }),
                el('th', { text: '' }),
                el('th', { class: 'num', text: 'Calls' }),
                el('th', { class: 'num', text: 'Longest' }),
                el('th', { class: 'num', text: 'Failed' }),
              ),
            ),
            el(
              'tbody',
              {},
              l.bash.slice(0, 40).map(([k, ms, n, max, err]) =>
                el(
                  'tr',
                  {
                    class: 'row',
                    onclick: () => {
                      app.els.kind.value = 'shell';
                      app.els.q.value = k.replace(/ \[bg\]$/, '');
                      activateTab('trace');
                    },
                  },
                  el('td', {}, k),
                  el('td', { class: 'num' }, fmt(ms)),
                  el(
                    'td',
                    {},
                    el(
                      'span',
                      { class: 'track', style: 'width:120px' },
                      el('span', {
                        class: 'bar',
                        style: `width:${Math.max(1, Math.round((120 * ms) / shellMax))}px;background:${color('shell')}`,
                      }),
                    ),
                  ),
                  el('td', { class: 'num' }, n),
                  el('td', { class: 'num' }, fmt(max)),
                  el('td', { class: `num${err ? ' fail' : ''}` }, err ? `✗ ${err}` : ''),
                ),
              ),
            ),
          ),
        ),
      ]
    : [MISSING, MISSING];
  const compactions: Child[] = st.compactions.length
    ? [
        el('h3', {}, 'Compactions'),
        el(
          'ul',
          { class: 'linklist' },
          st.compactions.map((c) =>
            el(
              'li',
              {},
              `${kTok(c.pre)} → ${kTok(c.post)} tokens`,
              el('span', { class: 'muted' }, c.trigger),
              el('span', { class: 'num' }, fmt(c.ms)),
            ),
          ),
        ),
      ]
    : [MISSING, MISSING];
  byId('tab-breakdown', HTMLDivElement).replaceChildren(
    ...present<Node | string>([
      el('h3', {}, 'Where the time went'),
      el(
        'p',
        { class: 'muted', style: 'margin:0 0 8px' },
        `Shares are of ${fmt(st.active)} active time. Parallel tool calls are charged to whichever finishes, so nothing is counted twice.`,
      ),
      hbars(app, rows, st.active),
      ...shell.map(toNode),
      el('h3', {}, 'Slowest tool calls'),
      spanList(slowTools, (s) => (s.t === 't' ? s.name : 'model')),
      el('h3', {}, 'Slowest model responses'),
      spanList(slowModel, (s) => (s.t === 'm' && s.out != null ? `${kTok(s.out)} out` : 'model')),
      ...compactions.map(toNode),
    ]),
  );
}

/** What the prototype's breakdown shows for a section it leaves out: replaceChildren's text for null. */
const MISSING = 'null';

/** A child as a node or text, for replaceChildren; nothing for null, undefined, or false. */
function toNode(c: Child): Node | string | null {
  if (c == null || c === false) return null;
  return c instanceof Node ? c : String(c);
}

/** Opens a tab, as a click on it does. */
function activateTab(name: Tab): void {
  query(`.tabs button[data-tab="${name}"]`, HTMLButtonElement).click();
}

function renderAgents(app: App): void {
  const { stamp } = app;
  const sub = app.lanes.slice(1);
  const groupLabel = (id: string): string => {
    const g = app.groups.find((x) => x.id === id);
    return g ? `${g.label}${g.kind !== undefined ? ` ${id}` : ''}` : id;
  };
  const max = Math.max(...sub.map((x) => x.stats.active));
  const heads = ['Group', 'Agent', 'Start', 'Wall', 'Active', 'Where it went', 'Model', 'Tools', 'Calls'];
  byId('tab-agents', HTMLDivElement).replaceChildren(
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...heads.map((h, i) => el('th', { class: i >= 3 && i !== 5 ? 'num' : '' }, h)))),
        el(
          'tbody',
          {},
          sub.map((l) =>
            el(
              'tr',
              {
                class: `row${l === app.cur ? ' sel' : ''}`,
                onclick: () => {
                  app.showLane(l);
                },
              },
              el('td', { class: 'muted' }, groupLabel(l.group)),
              el('td', { class: 'wide', title: l.label }, `${l.nested ? '↳ ' : ''}${laneName(l)}`),
              el('td', { class: 'time' }, stamp(l.start)),
              el('td', { class: 'num' }, fmt(l.stats.wall)),
              el('td', { class: 'num' }, fmt(l.stats.active)),
              el('td', {}, composition(app, l.buckets, max)),
              el('td', { class: 'num' }, fmt(l.stats.model)),
              el('td', { class: 'num' }, fmt(l.stats.tools)),
              el('td', { class: 'num' }, l.stats.calls),
            ),
          ),
        ),
      ),
    ),
    el(
      'p',
      { class: 'muted' },
      'Subagents run alongside the session, so their time overlaps it. Click one to show its trace.',
    ),
  );
}

function copyButton(text: string): HTMLButtonElement {
  const button = el('button', { type: 'button' }, 'Copy');
  button.addEventListener('click', () => {
    const copied = (async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    })();
    void copied;
  });
  return button;
}

/** A titled block of text with a copy button; nothing for an empty text. */
function block(title: string, text: string): HTMLElement[] {
  if (!text) return [];
  return [el('div', { class: 'section-head' }, el('h3', {}, title), copyButton(text)), el('pre', {}, text)];
}

type Pair = readonly [string, Node | string | null | undefined];

/** A definition list of the pairs that have a value. */
function dl(pairs: readonly (Pair | null)[]): HTMLDListElement {
  return el(
    'dl',
    {},
    pairs.flatMap((p) => (p?.[1] != null && p[1] !== '' ? [el('dt', {}, p[0]), el('dd', {}, p[1])] : [])),
  );
}

function link(text: string, onclick: () => void): HTMLAnchorElement {
  return el(
    'a',
    {
      href: '#',
      onclick: (e) => {
        e.preventDefault();
        onclick();
      },
    },
    text,
  );
}

function turnLink(app: App, l: Lane, n: number | null): Node | string | null {
  if (!n) return null;
  const i = l.turns.findIndex((t) => t.n === n);
  const t = l.turns[i];
  return t === undefined
    ? `#${n}`
    : link(`#${n} ${oneLine(t.text, 60)}`, () => {
        app.select({ type: 'turn', l, i });
      });
}

function laneLink(app: App, l: Lane, text?: string): HTMLAnchorElement {
  return link(text ?? laneName(l), () => {
    app.showLane(l);
  });
}

function laneItem(app: App, l: Lane, ...kids: Child[]): HTMLLIElement {
  return el(
    'li',
    {
      onclick: () => {
        app.showLane(l);
      },
    },
    ...kids,
  );
}

export function renderDetail(app: App): void {
  const d = app.els.detail;
  const { stamp } = app;
  const l = app.cur;
  const sel = app.sel;
  const categories = app.data.toolCategories;
  if (!sel) {
    const st = l.stats;
    const parent = l.parent ? app.laneById.get(l.parent) : undefined;
    const launcher = parent ? parent.spans.findIndex((s) => s.t === 't' && s.agent === l.id) : -1;
    const launch = parent?.spans[launcher];
    const group = app.groups.find((g) => g.id === l.group && g.kind !== undefined);
    d.replaceChildren(
      el('h2', {}, laneName(l)),
      el('div', { class: 'muted' }, l.id === 'main' ? app.data.session.id : `agent ${l.id}`),
      el(
        'div',
        { class: 'big' },
        fmt(st.active),
        el('span', { class: 'muted', style: 'font-size:13px;font-weight:400' }, ' active'),
      ),
      dl([
        ['Started', stamp(l.start)],
        ['Ended', stamp(l.end)],
        ['Wall clock', fmt(st.wall)],
        ['Model', `${fmt(st.model)} · ${pct(st.model, st.active)}`],
        ['Tools', `${fmt(st.tools)} · ${pct(st.tools, st.active)}`],
        ['Model calls', String(st.calls)],
        ['Tool calls', String(st.toolCalls)],
        ['Models', st.models.join(', ')],
        l.agentType ? ['Agent type', l.agentType] : null,
        group?.kind !== undefined
          ? [group.kind, `${group.label} ${group.id}${group.status ? ` · ${group.status}` : ''}`]
          : null,
        parent
          ? [
              'Launched by',
              launch?.t === 't'
                ? link(`${launch.name} call in ${parent.label}`, () => {
                    app.select({ type: 'span', l: parent, i: launcher });
                  })
                : laneLink(app, parent),
            ]
          : null,
        app.data.session.cwd && l.id === 'main' ? ['Directory', app.data.session.cwd] : null,
      ]),
      el(
        'p',
        { class: 'muted' },
        'Click a span in the timeline or a row in the trace to see what it ran and returned.',
      ),
    );
    return;
  }
  if (sel.type === 'span') {
    const s = l.spans[sel.i];
    if (!s) return;
    const chips = present([
      failed(s) ? el('span', { class: 'chip fail' }, s.t === 't' && s.intr ? '✗ interrupted' : '✗ failed') : null,
      s.t === 't' && s.async ? el('span', { class: 'chip' }, 'ran in the background') : null,
      s.t === 'm' && s.think ? el('span', { class: 'chip' }, 'thinking') : null,
      s.t === 'm' && s.syn ? el('span', { class: 'chip' }, 'synthetic') : null,
      s.t === 'm' && s.stop ? el('span', { class: 'chip' }, `stop: ${s.stop}`) : null,
    ]);
    const kids: (HTMLElement | null)[] = [
      el('h2', {}, app.key(catOfSpan(s)), ' ', spanName(s)),
      s.t === 't' && s.desc ? el('div', { class: 'secondary' }, s.desc) : null,
      el('div', { class: 'big' }, s.ms == null ? 'unfinished' : fmt(s.ms)),
      chips.length ? el('div', { class: 'chips' }, chips) : null,
      dl([
        ['Started', stamp(s.s)],
        ['Ended', stamp(s.e)],
        s.t === 't' && s.async && s.bgEnd
          ? ['Reported back', `${stamp(s.bgEnd)} · ${fmt(s.bgEnd - s.s)} after launch`]
          : null,
        ['Turn', turnLink(app, l, s.turn)],
        s.t === 'm' ? ['Model', s.model] : null,
        s.t === 'm' && s.out != null ? ['Output tokens', kTok(s.out)] : null,
        s.t === 'm' && s.cr != null ? ['Cache read', kTok(s.cr)] : null,
        s.t === 'm' && s.cw != null ? ['Cache written', kTok(s.cw)] : null,
        ['Lane', laneLink(app, l)],
      ]),
    ];
    if (s.t === 't') {
      const agentLane = s.agent ? app.laneById.get(s.agent) : undefined;
      const runLanes = s.run ? app.lanes.filter((x) => x.group === s.run) : [];
      if (agentLane)
        kids.push(
          el('div', { class: 'section-head' }, el('h3', {}, 'Agent')),
          el(
            'ul',
            { class: 'linklist' },
            laneItem(
              app,
              agentLane,
              app.key('tool'),
              agentLane.label,
              el('span', { class: 'num' }, fmt(agentLane.stats.wall)),
            ),
          ),
        );
      if (runLanes.length) {
        const kind = app.groups.find((g) => g.id === s.run)?.kind ?? 'Group';
        kids.push(
          el('div', { class: 'section-head' }, el('h3', {}, `${kind} agents (${runLanes.length})`)),
          el(
            'ul',
            { class: 'linklist' },
            runLanes.map((x) =>
              laneItem(
                app,
                x,
                el('span', { class: 'muted' }, x.phase ?? ''),
                x.label,
                el('span', { class: 'num' }, fmt(x.stats.wall)),
              ),
            ),
          ),
        );
      }
      kids.push(...block(s.cat === 'shell' ? 'Command' : 'Input', s.in), ...block('Output', s.out));
    } else {
      if (s.tools.length)
        kids.push(
          el('div', { class: 'section-head' }, el('h3', {}, `Tool calls (${s.tools.length})`)),
          el(
            'ul',
            { class: 'linklist' },
            s.tools.map((i) => {
              const t = l.spans[i];
              if (t?.t !== 't') return null;
              return el(
                'li',
                {
                  onclick: () => {
                    app.select({ type: 'span', l, i });
                  },
                },
                app.key(catOfSpan(t)),
                el('span', {}, t.name),
                el('span', { class: 'muted' }, oneLine(t.desc || t.pv, 70)),
                el('span', { class: 'num' }, t.ms == null ? '…' : fmt(t.ms)),
              );
            }),
          ),
        );
      kids.push(...block('Text', s.text));
      if (s.think && !s.text && !s.tools.length)
        kids.push(el('p', { class: 'muted' }, 'Thinking only; transcripts keep no thinking text.'));
    }
    d.replaceChildren(...present(kids));
    return;
  }
  if (sel.type === 'seg') {
    const g = l.seg[sel.i];
    if (!g) return;
    const [s, e, b] = g;
    d.replaceChildren(
      el('h2', {}, app.key(catOfBucket(b, categories)), ' ', bucketLabel(b)),
      el('div', { class: 'big' }, fmt(e - s)),
      dl([
        ['Started', stamp(s)],
        ['Ended', stamp(e)],
        ['Lane', laneLink(app, l)],
      ]),
      el('p', { class: 'muted' }, 'A stretch of the state track: what the session was waiting on between two events.'),
    );
    return;
  }
  const t = l.turns[sel.i];
  if (!t) return;
  d.replaceChildren(
    ...present<HTMLElement>([
      el('h2', {}, `Turn #${t.n}`),
      el(
        'div',
        { class: 'secondary' },
        t.kind === 'you' ? 'Your prompt' : t.kind === 'task' ? 'A background task reported back' : `Command ${t.text}`,
      ),
      el(
        'div',
        { class: 'big' },
        fmt(t.active),
        el('span', { class: 'muted', style: 'font-size:13px;font-weight:400' }, ' active'),
      ),
      dl([
        ['Started', stamp(t.ts)],
        ['Ended', stamp(t.end)],
        ['Model calls', String(t.calls)],
        ['Tool calls', String(t.tools)],
        ['Lane', laneLink(app, l)],
      ]),
      el('h3', {}, 'Where it went'),
      hbars(
        app,
        t.b
          .filter(([k]) => !isIdle(k))
          .sort((a, b) => b[1] - a[1])
          .map(([b, ms]) => ({ label: bucketLabel(b), cat: catOfBucket(b, categories), ms, idle: false })),
        t.active,
      ),
      ...block(t.kind === 'task' ? 'Notification' : 'Prompt', t.text),
    ]),
  );
}
