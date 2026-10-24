import type {
  CompactionItem,
  ContextItem,
  ConversationData,
  ConversationItem,
  ConversationTurn,
  Finding,
  FindingRef,
  ModelItem,
  NoticeItem,
  PromptItem,
  ResultItem,
  Shape,
  Thread,
  ToolBlock,
} from '../../view/types.js';
import { agentTree, AgentTree } from './agentTree.js';
import { readColors } from './colors.js';
import { drawContextChart } from './contextChart.js';
import {
  blockShown,
  FILTERS,
  isFailure,
  isFilter,
  itemShown,
  matches,
  showsAll,
  turnShown,
  turnTools,
  type ConversationFilter,
  type FilterState,
} from './conversationFilter.js';
import { calledTools, modelCalls, settingsOf, shapeChanges } from './conversationSetup.js';
import { byId, copyButton, el, nodes, present, queryAll, type Child } from './dom.js';
import { fmt, kTok, oneLine, spansDays, stamp } from './format.js';
import { parseTarget, targetHash, type Target } from './links.js';
import { applyTheme, cycleTheme, onThemeApplied } from './theme.js';

// The conversation page: one thread at a time (the main session's or an agent's), turn by turn,
// with the tree of the session's agents over time to move between threads, an outline of the turns, a chart of the context, filters, the findings (what looks worth
// improving, with where each happened), and a drawer with the system prompt and tools the thread's
// model calls were sent with. A tool call, a reasoning, the harness's context, or a compaction's
// summary is one row until it is opened; what an opened row shows is built when it is first
// opened, so that a long thread stays quick.

/** How many places of a finding the rail lists. */
const PLACES_SHOWN = 100;

/** How many rows "Expand all" opens at most. */
const EXPAND_LIMIT = 400;

/** What the filter's options read; the shell's is named after the agent's shell tool. */
function filterLabel(f: ConversationFilter, shell: string): string {
  switch (f) {
    case 'all':
      return 'Everything';
    case 'dialogue':
      return 'Prompts and replies';
    case 'tools':
      return 'Tool calls';
    case 'shell':
      return shell;
    case 'failed':
      return 'Failed, interrupted, or refused';
    case 'harness':
      return 'Harness context';
    case 'thinking':
      return 'Recorded reasoning';
    case 'slow':
      return 'Slower than 10s';
  }
}

/** A tool category's color class: the shell's, the person's for a question, or other tools'. */
function keyClass(category: string): string {
  return category === 'shell' ? 'shell' : category === 'question' ? 'you' : 'tool';
}

/** A count and its noun, plural unless it is one. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A token delta, signed. */
function delta(n: number): string {
  return n < 0 ? `−${kTok(-n)}` : `+${kTok(n)}`;
}

/** A prompt's speaker; an agent's prompts come from the agent that launched it, not from the person. */
function whoOf(p: PromptItem, agent: boolean): string {
  if (p.by === 'task') return 'Task report';
  if (p.by === 'command') return 'Command';
  if (p.origin !== null) return `Prompt · ${p.origin}`;
  return agent ? 'Prompt' : 'You';
}

/** A text for a one-line excerpt: its markup tags dropped. */
function plain(text: string): string {
  return text.replace(/<[^>]*>/g, ' ');
}

export class ConversationPage {
  readonly data: ConversationData;
  readonly threads: readonly Thread[];
  readonly byId: ReadonlyMap<string, Thread>;
  readonly shapes: ReadonlyMap<string, Shape>;
  readonly multiDay: boolean;
  /** Whether the findings rail shows every thread's findings, or the shown thread's. */
  allFindings = false;
  /** The finding whose places N steps through, and the place it is at. */
  private stepping: { readonly finding: Finding; at: number } | null = null;
  /** The shape the drawer shows, when it is open. */
  private setupShape: string | null = null;
  thread: Thread;
  state: FilterState = { filter: 'all', query: '', harness: true };
  /** The keys of the opened rows. */
  readonly open = new Set<string>();
  private readonly els = {
    root: byId('conversation', HTMLDivElement),
    threadSelect: byId('cv-thread', HTMLSelectElement),
    launch: byId('cv-launch', HTMLSpanElement),
    stats: byId('cv-stats', HTMLElement),
    chart: byId('cv-chart', HTMLDivElement),
    q: byId('cv-q', HTMLInputElement),
    filter: byId('cv-filter', HTMLSelectElement),
    harness: byId('cv-harness', HTMLInputElement),
    count: byId('cv-count', HTMLSpanElement),
    outline: byId('cv-outline', HTMLElement),
    stream: byId('cv-stream', HTMLElement),
    findings: byId('cv-findings', HTMLElement),
    setup: byId('cv-setup', HTMLElement),
    setupBody: byId('cv-setup-body', HTMLDivElement),
    setupSub: byId('cv-setup-sub', HTMLSpanElement),
    setupOpen: byId('cv-setup-open', HTMLButtonElement),
    tip: byId('tip', HTMLDivElement),
  };
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private spy: IntersectionObserver | undefined;
  /** The tree of agents over time, when the session has agents. */
  private tree: AgentTree | null = null;

  constructor(data: ConversationData) {
    this.data = data;
    this.threads = data.conversation.threads;
    this.byId = new Map(this.threads.map((t) => [t.id, t]));
    this.shapes = new Map(data.conversation.shapes.map((s) => [s.id, s]));
    const [main] = this.threads;
    if (main === undefined) throw new Error('the conversation has no thread');
    this.thread = main;
    const starts = present(this.threads.map((t) => t.start));
    const ends = present(this.threads.map((t) => t.end));
    this.multiDay = starts.length > 0 && spansDays(Math.min(...starts), Math.max(...ends));
  }

  stamp = (t: number | null): string => stamp(t, this.multiDay);

  start(): void {
    const { data, els } = this;
    const { session } = data.conversation;
    els.root.hidden = false;
    const title = session.title ?? session.id;
    document.title = `${session.title ?? session.id.slice(0, 8)} · conversation`;
    byId('cv-title', HTMLHeadingElement).textContent = title;
    byId('cv-subtitle', HTMLSpanElement).textContent =
      `${session.id}${session.cwd === null ? '' : ` · ${session.cwd}`}`;
    const back = byId('cv-back', HTMLAnchorElement);
    back.hidden = data.serve !== true;
    if (data.indexHref !== undefined) back.href = data.indexHref;
    const timeline = byId('cv-timeline', HTMLAnchorElement);
    if (data.timelineHref !== undefined) {
      timeline.href = data.timelineHref;
      timeline.hidden = false;
    }
    readColors();
    applyTheme();
    byId('cv-theme', HTMLButtonElement).addEventListener('click', () => {
      cycleTheme();
    });

    els.threadSelect.replaceChildren(
      ...this.threads.map((t) => {
        const serious = t.findings.filter((f) => f.severity !== 'low').length;
        return el(
          'option',
          { value: t.id },
          (t.id === 'main'
            ? `${t.label} · ${count(t.stats.calls, 'model call')}`
            : `${t.parent !== null && t.parent !== 'main' ? '↳ ' : ''}${t.phase ? `${t.phase} · ` : ''}${t.label}${t.agentType ? ` (${t.agentType})` : ''}`) +
            (serious ? ` · ${count(serious, 'finding')}` : ''),
        );
      }),
    );
    els.threadSelect.disabled = this.threads.length < 2;
    els.threadSelect.addEventListener('change', () => {
      const t = this.byId.get(els.threadSelect.value);
      if (t) this.show(t, { lane: t.id });
    });
    this.startTree();
    els.filter.replaceChildren(
      ...FILTERS.map((f) => el('option', { value: f }, filterLabel(f, data.conversation.shellLabel))),
    );
    els.filter.addEventListener('change', () => {
      const f = els.filter.value;
      if (isFilter(f)) this.setState({ ...this.state, filter: f });
    });
    els.harness.addEventListener('change', () => {
      this.setState({ ...this.state, harness: els.harness.checked });
    });
    els.q.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.setState({ ...this.state, query: els.q.value.trim().toLowerCase() });
      }, 180);
    });
    byId('cv-expand', HTMLButtonElement).addEventListener('click', () => {
      this.expandAll();
    });
    byId('cv-collapse', HTMLButtonElement).addEventListener('click', () => {
      this.open.clear();
      this.renderStream();
    });
    els.setupOpen.addEventListener('click', () => {
      this.openSetup(null);
    });
    byId('cv-setup-close', HTMLButtonElement).addEventListener('click', () => {
      this.closeSetup();
    });
    this.bindKeys();
    new ResizeObserver(() => {
      this.renderChart();
    }).observe(els.chart.parentElement ?? els.chart);
    window.addEventListener('hashchange', () => {
      this.goTo(parseTarget(location.hash));
    });

    const target = parseTarget(location.hash);
    const first = target === null ? undefined : this.byId.get(target.lane);
    this.show(first ?? this.thread, target);
  }

  /** Shows the tree of agents over time, when the session has agents. */
  private startTree(): void {
    const root = agentTree(this.threads, this.data.conversation.groups);
    if (root === null || this.threads.length < 2) return;
    const scroll = byId('cv-tree-scroll', HTMLDivElement);
    const tree = new AgentTree(
      {
        axis: byId('cv-tree-axis', HTMLCanvasElement),
        rows: byId('cv-tree-rows', HTMLCanvasElement),
        scroll,
        spacer: byId('cv-tree-spacer', HTMLDivElement),
        tip: this.els.tip,
        compress: byId('cv-tree-compress', HTMLInputElement),
        fit: byId('cv-tree-fit', HTMLButtonElement),
        multiDay: this.multiDay,
        stamp: this.stamp,
        open: (t) => {
          this.show(t, { lane: t.id });
        },
      },
      root,
      this.threads,
    );
    this.tree = tree;
    byId('cv-tree', HTMLElement).hidden = false;
    const kinds = new Map<string, number>();
    for (const g of this.data.conversation.groups) kinds.set(g.kind, (kinds.get(g.kind) ?? 0) + 1);
    byId('cv-tree-sub', HTMLSpanElement).textContent = [
      count(this.threads.length - 1, 'agent'),
      ...[...kinds].map(([kind, n]) => count(n, kind ? kind.toLowerCase() : 'group')),
      `at most ${tree.peak} at once`,
    ].join(' · ');
    const key = (css: string, label: string): HTMLElement =>
      el('span', {}, el('span', { class: 'key', style: `background:var(${css})` }), label);
    byId('cv-tree-legend', HTMLSpanElement).replaceChildren(
      key('--series-1', 'Model'),
      key('--series-2', this.data.conversation.shellLabel),
      key('--series-3', 'Other tools'),
      key('--wait-you', 'Waiting'),
      el('span', {}, '└ launched by its parent’s call'),
    );
    const toggle = byId('cv-tree-toggle', HTMLButtonElement);
    const body = byId('cv-tree-body', HTMLDivElement);
    toggle.addEventListener('click', () => {
      const opening = body.hidden;
      body.hidden = !opening;
      toggle.setAttribute('aria-expanded', String(opening));
      if (opening) tree.resize();
    });
    new ResizeObserver(() => {
      tree.resize();
    }).observe(scroll);
    onThemeApplied(() => {
      tree.draw();
    });
    tree.resize();
  }

  // ---------- threads and state ----------

  /** Shows a thread, then what `target` points at in it. */
  show(t: Thread, target: Target | null = null): void {
    const changed = t !== this.thread || !this.els.stream.hasChildNodes();
    this.thread = t;
    this.els.threadSelect.value = t.id;
    this.tree?.setCurrent(t.id);
    if (changed) {
      this.tree?.setCursor(null);
      this.renderStats();
      this.renderLaunch();
      this.renderChart();
      this.renderStream();
      this.renderFindings();
      this.renderSetupButton();
      if (this.setupShape !== null) this.openSetup(null);
      window.scrollTo({ top: 0 });
    }
    const hash = targetHash(target ?? { lane: t.id });
    if (location.hash !== hash) history.replaceState(null, '', hash);
    if (target !== null) this.reveal(target);
  }

  setState(state: FilterState): void {
    this.state = state;
    this.renderStream();
  }

  /** Goes to what a link points at: its thread, then the call in it. */
  goTo(target: Target | null): void {
    if (target === null) return;
    const t = this.byId.get(target.lane);
    if (t) this.show(t, target);
  }

  /** Opens and shows what `target` points at, clearing a filter that hides it. */
  reveal(target: Target): void {
    const find = (): Element | null =>
      'tool' in target
        ? this.els.stream.querySelector(`[data-tool="${CSS.escape(target.tool)}"]`)
        : 'model' in target
          ? this.els.stream.querySelector(`[data-model="${CSS.escape(target.model)}"]`)
          : 'item' in target
            ? this.findItem(target.item)
            : null;
    if (!('tool' in target || 'model' in target || 'item' in target)) return;
    let node = find();
    if (node === null && !showsAll(this.state)) {
      this.els.q.value = '';
      this.els.filter.value = 'all';
      this.els.harness.checked = true;
      this.state = { filter: 'all', query: '', harness: true };
      this.renderStream();
      node = find();
    }
    if (!(node instanceof HTMLElement)) return;
    if ('tool' in target) {
      this.open.add(`tool:${target.tool}`);
      this.fill(node);
    } else if ('item' in target) {
      // A harness item's row, or the row of a card such as a compaction's, opens.
      const unit = node.classList.contains('cv-unit') ? node : node.querySelector(':scope > .cv-unit');
      if (unit instanceof HTMLElement && !node.classList.contains('cv-model')) this.fill(unit);
    }
    this.flash(node);
  }

  /** The element of a turn's item, `<turn>.<index>`; a harness item's group is opened to find it. */
  private findItem(item: string): Element | null {
    const selector = `[data-item="${CSS.escape(item)}"]`;
    const found = this.els.stream.querySelector(selector);
    if (found !== null) return found;
    const [turn, index] = item.split('.').map(Number);
    for (const group of queryAll('[data-from]', HTMLElement, this.els.stream))
      if (
        Number(group.getAttribute('data-turn')) === turn &&
        Number(group.getAttribute('data-from')) <= (index ?? -1) &&
        (index ?? Infinity) <= Number(group.getAttribute('data-to'))
      ) {
        this.fill(group);
        return this.els.stream.querySelector(selector);
      }
    return null;
  }

  private flash(node: HTMLElement): void {
    node.scrollIntoView({ block: 'center' });
    // Removed, then added on the next frame, so that the animation starts again.
    node.classList.remove('cv-flash');
    requestAnimationFrame(() => {
      node.classList.add('cv-flash');
    });
  }

  // ---------- the header parts ----------

  private renderStats(): void {
    const s = this.thread.stats;
    const tile = (k: string, v: string, sub = ''): HTMLElement =>
      el(
        'div',
        { class: 'tile' },
        el('div', { class: 'k' }, k),
        el('div', { class: 'v' }, v),
        el('div', { class: 's' }, sub),
      );
    this.els.stats.replaceChildren(
      tile('Wall', fmt(s.wall)),
      tile('Active', fmt(s.active), `model ${fmt(s.model)} · tools ${fmt(s.tools)} · you ${fmt(s.you)}`),
      tile('Model calls', String(s.calls), s.out === null ? '' : `${kTok(s.out)} output tokens`),
      tile('Tool calls', String(s.toolCalls), `${s.failed} failed or interrupted · ${s.denied} refused`),
      tile('Peak context', s.peakContext === null ? '–' : kTok(s.peakContext), 'tokens a model call read'),
      tile('Harness context', `~${kTok(s.contextTokens)}`, `${count(s.contextItems, 'item')}, estimated tokens`),
      tile('Compactions', String(s.compactions)),
    );
  }

  /** For an agent's thread: the call that launched it, and a way back to it. */
  private renderLaunch(): void {
    const t = this.thread;
    const parent = t.parent === null ? undefined : this.byId.get(t.parent);
    if (parent === undefined) {
      this.els.launch.replaceChildren();
      return;
    }
    let where = '';
    let call: ToolBlock | undefined;
    for (const turn of parent.turns)
      for (const i of turn.items)
        if (i.type === 'model')
          for (const b of i.blocks)
            if (b.type === 'tool' && (b.id === t.launcher || (t.launcher === null && b.agent === t.id))) {
              call = b;
              where = turn.n === 0 ? '' : `, turn ${turn.n}`;
            }
    this.els.launch.replaceChildren(
      `Launched by ${call === undefined ? 'a call' : call.name} in ${parent.label}${where} · `,
      el(
        'a',
        {
          href: targetHash(call === undefined ? { lane: parent.id } : { lane: parent.id, tool: call.id }),
          onclick: (e) => {
            e.preventDefault();
            this.show(parent, call === undefined ? null : { lane: parent.id, tool: call.id });
          },
        },
        'show the call',
      ),
    );
  }

  private renderChart(): void {
    const host = this.els.chart;
    const width = Math.max(200, (host.parentElement ?? host).clientWidth - 40 - 26);
    drawContextChart(
      host,
      this.thread.turns,
      width,
      (model) => {
        this.show(this.thread, { lane: this.thread.id, model: model.id });
      },
      (at) => {
        const tip = this.els.tip;
        if (at === null) {
          tip.hidden = true;
          return;
        }
        const m = at.point.model;
        tip.replaceChildren(
          el('div', { class: 'v' }, `${kTok(at.point.context)} tokens`),
          el('div', { class: 'd' }, `Model call ${at.index + 1}${at.point.turn ? ` · turn ${at.point.turn}` : ''}`),
          el('div', { class: 'd' }, `${this.stamp(m.ts)} · ${fmt(m.ms)}${m.model === null ? '' : ` · ${m.model}`}`),
        );
        tip.hidden = false;
        tip.style.left = `${Math.min(window.innerWidth - 260, at.x + 14)}px`;
        tip.style.top = `${at.y + 14}px`;
      },
    );
  }

  // ---------- the outline and the stream ----------

  renderStream(): void {
    const { thread, state, els } = this;
    this.spy?.disconnect();
    const shown = new Set(thread.turns.filter((t) => turnShown(t, state)));
    let previous: number | null = null;
    const sections: HTMLElement[] = [];
    for (const turn of thread.turns) {
      // The context of the model call before each one, so that each shows what it added, filtered or not.
      const before = previous;
      for (const i of turn.items) if (i.type === 'model' && i.context !== null) previous = i.context;
      if (shown.has(turn)) sections.push(this.turnSection(turn, before));
    }
    const all = thread.turns.length;
    els.stream.replaceChildren(
      ...(sections.length
        ? sections
        : [
            el(
              'div',
              { class: 'pane cv-empty muted' },
              all ? 'Nothing matches the filter.' : 'This thread has no turns.',
            ),
          ]),
    );
    els.count.textContent = showsAll(state) ? count(all, 'turn') : `${shown.size} of ${count(all, 'turn')} match`;
    this.renderOutline(shown);
  }

  private renderOutline(shown: ReadonlySet<ConversationTurn>): void {
    const links = new Map<number, HTMLAnchorElement>();
    const rows = this.thread.turns.map((turn) => {
      const prompt = turn.items.find((i): i is PromptItem => i.type === 'prompt');
      const { calls, failures } = turnTools(turn);
      const text =
        turn.n === 0
          ? 'Before the first prompt'
          : oneLine(plain(prompt?.summary ?? prompt?.text ?? ''), 90) || '(no text)';
      const a = el(
        'a',
        {
          href: '#',
          class: shown.has(turn) ? '' : 'dim',
          title: `${this.stamp(turn.ts)} · active ${fmt(turn.active)}`,
          onclick: (e) => {
            e.preventDefault();
            document.getElementById(`cv-turn-${turn.n}`)?.scrollIntoView({ block: 'start' });
          },
        },
        el('span', { class: 'n' }, turn.n === 0 ? '·' : String(turn.n)),
        el('span', { class: `cv-who ${turn.kind ?? 'none'}` }),
        el('span', { class: 't' }, text),
        calls ? el('span', { class: 'meta' }, String(calls)) : null,
        failures ? el('span', { class: 'fail' }, `✗${failures}`) : null,
      );
      links.set(turn.n, a);
      return a;
    });
    this.els.outline.replaceChildren(
      el('div', { class: 'cv-outline-head muted' }, count(this.thread.turns.filter((t) => t.n > 0).length, 'turn')),
      ...rows,
    );
    // The outline marks the turn at the top of the window.
    this.spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            const n = Number(e.target.getAttribute('data-turn'));
            for (const [k, a] of links) a.classList.toggle('on', k === n);
            this.tree?.setCursor(this.thread.turns.find((x) => x.n === n)?.ts ?? null);
          }
      },
      { rootMargin: '0px 0px -80% 0px' },
    );
    for (const section of queryAll('.cv-turn', HTMLElement, this.els.stream)) this.spy.observe(section);
  }

  private turnSection(turn: ConversationTurn, before: number | null): HTMLElement {
    const { calls, failures } = turnTools(turn);
    const head = el(
      'div',
      { class: 'cv-turn-head' },
      el('h2', {}, turn.n === 0 ? 'Before the first prompt' : `Turn ${turn.n}`),
      turn.kind === null ? null : el('span', { class: 'chip' }, turn.kind),
      el('span', { class: 'muted' }, this.stamp(turn.ts)),
      el('span', { class: 'muted' }, `active ${fmt(turn.active)}`),
      calls ? el('span', { class: 'muted' }, count(calls, 'tool call')) : null,
      failures ? el('span', { class: 'chip fail' }, `${failures} failed`) : null,
    );
    const body: HTMLElement[] = [];
    let previous = before;
    let harness: { readonly item: ContextItem; readonly index: number }[] = [];
    const flush = (): void => {
      if (harness.length) body.push(this.harnessCard(turn, harness));
      harness = [];
    };
    turn.items.forEach((item, index) => {
      const change =
        item.type === 'model' && item.context !== null && previous !== null ? item.context - previous : null;
      if (item.type === 'model' && item.context !== null) previous = item.context;
      if (!itemShown(item, this.state)) return;
      if (item.type === 'context') {
        harness.push({ item, index });
        return;
      }
      flush();
      const card = this.itemCard(item, change);
      card.setAttribute('data-item', `${turn.n}.${index}`);
      body.push(card);
    });
    flush();
    return el('section', { class: 'cv-turn', id: `cv-turn-${turn.n}`, 'data-turn': turn.n }, head, ...body);
  }

  private itemCard(item: Exclude<ConversationItem, ContextItem>, change: number | null): HTMLElement {
    switch (item.type) {
      case 'prompt':
        return this.promptCard(item);
      case 'model':
        return this.modelCard(item, change);
      case 'compaction':
        return this.compactionCard(item);
      case 'notice':
        return this.noticeLine(item);
      case 'result':
        return this.resultCard(item);
    }
  }

  // ---------- text ----------

  /** A text with the search's matches marked. */
  private marked(text: string): (Node | string)[] {
    const ranges = matches(text, this.state.query);
    if (!ranges.length) return [text];
    const out: (Node | string)[] = [];
    let at = 0;
    for (const [a, b] of ranges) {
      out.push(text.slice(at, a), el('mark', {}, text.slice(a, b)));
      at = b;
    }
    out.push(text.slice(at));
    return out;
  }

  private prose(text: string): HTMLElement {
    return el('div', { class: 'cv-prose' }, ...this.marked(text));
  }

  /** A titled block of text with a copy button; nothing for an empty text. */
  private textBlock(title: string, text: string): Child[] {
    if (!text) return [];
    return [
      el('div', { class: 'section-head' }, el('h3', {}, title), copyButton(text)),
      el('pre', {}, ...this.marked(text)),
    ];
  }

  // ---------- rows that open ----------

  /**
   * A row that opens to show `body`, built when it is first opened (no body: a row that does not
   * open). It is open when its key is, or when the search finds something in `hidden`, the text it
   * hides; `attrs` and `cls` go on its wrapper.
   */
  private row(
    key: string,
    head: readonly Child[],
    body: (() => Child[]) | null,
    opts: { readonly attrs?: Readonly<Record<string, string>>; readonly cls?: string; readonly hidden?: string } = {},
  ): HTMLElement {
    const hidden = opts.hidden ?? '';
    const searched = this.state.query !== '' && hidden !== '' && hidden.toLowerCase().includes(this.state.query);
    const opened = body !== null && (this.open.has(key) || searched);
    const wrap = el('div', {
      ...opts.attrs,
      class: `cv-unit${opts.cls ? ` ${opts.cls}` : ''}${opened ? ' open' : ''}`,
      'data-key': key,
    });
    const content = el('div', { class: 'cv-open' });
    content.hidden = !opened;
    const fill = (): void => {
      if (body !== null && !content.hasChildNodes()) content.replaceChildren(...nodes(body()));
    };
    if (opened) fill();
    const toggle = (): void => {
      if (body === null) return;
      const now = !wrap.classList.contains('open');
      wrap.classList.toggle('open', now);
      if (now) {
        this.open.add(key);
        fill();
      } else this.open.delete(key);
      content.hidden = !now;
      line.setAttribute('aria-expanded', String(now));
    };
    const line = el(
      'div',
      {
        class: `cv-row${body === null ? ' static' : ''}`,
        ...(body !== null && { role: 'button', tabindex: 0, 'aria-expanded': String(opened) }),
      },
      el('span', { class: 'cv-twist' }),
      ...nodes(head),
    );
    line.addEventListener('click', (e) => {
      if (e.target instanceof HTMLAnchorElement) return;
      toggle();
    });
    line.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    wrap.append(line, content);
    // Lets reveal open it from outside.
    wrapFills.set(wrap, () => {
      if (!wrap.classList.contains('open')) toggle();
    });
    return wrap;
  }

  /** Opens a row that `row` made. */
  private fill(node: HTMLElement): void {
    wrapFills.get(node)?.();
  }

  private expandAll(): void {
    let n = 0;
    for (const wrap of queryAll('.cv-unit', HTMLElement, this.els.stream)) {
      const key = wrap.getAttribute('data-key');
      if (key === null || wrap.querySelector('.cv-row.static') !== null) continue;
      if (n++ >= EXPAND_LIMIT) break;
      this.open.add(key);
    }
    this.renderStream();
    if (n > EXPAND_LIMIT) this.els.count.textContent += ` · opened the first ${EXPAND_LIMIT} rows`;
  }

  // ---------- items ----------

  private promptCard(p: PromptItem): HTMLElement {
    return el(
      'div',
      { class: `cv-card cv-prompt ${p.by}` },
      el(
        'div',
        { class: 'cv-card-head' },
        el('span', { class: 'who' }, whoOf(p, this.thread.id !== 'main')),
        el('span', {}, this.stamp(p.ts)),
        p.images ? el('span', { class: 'chip' }, count(p.images, 'image')) : null,
        p.summary === null ? null : el('span', { class: 'secondary' }, p.summary),
      ),
      p.text.trim() ? this.prose(p.text) : el('div', { class: 'cv-prose muted' }, '(no text)'),
    );
  }

  private modelCard(m: ModelItem, change: number | null): HTMLElement {
    const t = this.thread;
    const big = change !== null && change >= 10_000;
    const head = el(
      'div',
      { class: 'cv-card-head' },
      el('span', { class: 'who' }, 'Model'),
      m.model === null ? null : el('span', {}, m.model),
      el('span', {}, this.stamp(m.ts)),
      el('span', {}, fmt(m.ms)),
      m.context === null
        ? null
        : el(
            'span',
            {
              title:
                m.cacheRead === null || m.cacheWrite === null
                  ? 'Tokens the call read: input, cache reads, and cache writes'
                  : `Tokens the call read: ${m.cacheRead.toLocaleString()} from the cache, ${m.cacheWrite.toLocaleString()} written to it, ${(m.context - m.cacheRead - m.cacheWrite).toLocaleString()} other input`,
            },
            `context ${kTok(m.context)}`,
            change === null ? null : el('span', { class: big ? 'cv-grew' : '' }, ` (${delta(change)})`),
          ),
      m.out === null ? null : el('span', {}, `${kTok(m.out)} out`),
      m.stop !== null && m.stop !== 'end_turn' && m.stop !== 'tool_use'
        ? el('span', { class: 'chip' }, `stop: ${m.stop}`)
        : null,
      m.error
        ? el('span', { class: 'chip fail' }, 'API error')
        : m.synthetic
          ? el('span', { class: 'chip' }, 'written by the agent')
          : null,
      this.data.timelineHref === undefined
        ? null
        : el(
            'a',
            { class: 'cv-tl', href: `${this.data.timelineHref}${targetHash({ lane: t.id, model: m.id })}` },
            'timeline',
          ),
    );
    const blocks: HTMLElement[] = [];
    m.blocks.forEach((b, i) => {
      if (!blockShown(b, m, this.state)) return;
      switch (b.type) {
        case 'text':
          if (b.text.trim()) blocks.push(this.prose(b.text));
          break;
        case 'thinking': {
          const ms = b.ms === null ? '' : fmt(b.ms);
          blocks.push(
            this.row(
              `think:${m.id}:${i}`,
              [
                el('span', { class: 'cv-key think' }),
                el('span', { class: 'name' }, 'Thinking'),
                ms ? el('span', { class: 'meta' }, ms) : null,
                el(
                  'span',
                  { class: `what${b.text ? '' : ' muted'}` },
                  b.text ? oneLine(b.text, 160) : b.redacted ? 'redacted' : 'not recorded',
                ),
              ],
              b.text ? () => [el('div', { class: 'cv-prose' }, ...this.marked(b.text))] : null,
              { hidden: b.text },
            ),
          );
          break;
        }
        case 'other':
          blocks.push(
            this.row(
              `other:${m.id}:${i}`,
              [el('span', { class: 'cv-key tool' }), el('span', { class: 'name' }, b.label)],
              () => this.textBlock('Content', b.text),
              { hidden: b.text },
            ),
          );
          break;
        case 'tool':
          blocks.push(this.toolRow(b));
          break;
      }
    });
    return el('div', { class: 'cv-card cv-model', 'data-model': m.id }, head, ...blocks);
  }

  private toolRow(b: ToolBlock): HTMLElement {
    const failure = isFailure(b);
    const p = b.permission;
    const permission =
      p === null
        ? null
        : !p.allowed
          ? el('span', { class: 'chip fail' }, p.by === 'you' ? 'you refused' : `refused · ${p.by}`)
          : p.by === 'you'
            ? el('span', { class: 'chip' }, 'you allowed')
            : null;
    const status =
      b.status === 'error'
        ? el('span', { class: 'chip fail' }, 'failed')
        : b.status === 'interrupted'
          ? el('span', { class: 'chip fail' }, 'interrupted')
          : b.status === 'pending'
            ? el('span', { class: 'chip' }, 'no result')
            : null;
    const head: Child[] = [
      el('span', { class: `cv-key ${keyClass(b.category)}` }),
      el('span', { class: 'name' }, b.name),
      el(
        'span',
        { class: 'what', title: b.preview },
        b.purpose ? `${b.purpose}${b.detail ? ` · ${b.detail}` : ''}` : b.detail || b.preview,
      ),
      status,
      permission,
      b.async ? el('span', { class: 'chip' }, 'background') : null,
      b.agent === null ? null : el('span', { class: 'chip' }, 'agent'),
      el('span', { class: 'meta' }, `${fmt(b.ms)} · ~${kTok(b.tokens)}`),
    ];
    return this.row(`tool:${b.id}`, head, () => this.toolBody(b), {
      attrs: { 'data-tool': b.id },
      cls: failure ? 'cv-failure' : '',
      hidden: `${b.input}\n${b.output}`,
    });
  }

  private toolBody(b: ToolBlock): Child[] {
    const t = this.thread;
    const agent = b.agent === null ? undefined : this.byId.get(b.agent);
    const p = b.permission;
    const facts: (readonly [string, Child])[] = [
      ['Tool', `${b.name} · ${b.category}`],
      ...(b.purpose ? [['Purpose', b.purpose] as const] : []),
      ['When', `${this.stamp(b.start)} → ${b.end === null ? 'no result' : this.stamp(b.end)} · ${fmt(b.ms)}`],
      ['Status', b.status === 'ok' ? 'done' : b.status === 'pending' ? 'no result' : b.status],
      [
        'Output',
        `~${kTok(b.tokens)} tokens${b.images ? ` · ${count(b.images, 'image')}` : ''}${b.async ? ' · ran in the background' : ''}`,
      ],
    ];
    if (p !== null)
      facts.push(['Permission', `${p.allowed ? 'allowed' : 'refused'} · ${p.by === 'you' ? 'by you' : p.by}`]);
    return [
      el('dl', { class: 'cv-facts' }, ...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      el(
        'div',
        { class: 'cv-actions' },
        agent === undefined
          ? null
          : el(
              'button',
              {
                type: 'button',
                onclick: () => {
                  this.show(agent, { lane: agent.id });
                },
              },
              `Show the agent's conversation (${count(agent.stats.calls, 'model call')})`,
            ),
        this.data.timelineHref === undefined
          ? null
          : el(
              'a',
              { href: `${this.data.timelineHref}${targetHash({ lane: t.id, tool: b.id })}` },
              'Show in the timeline',
            ),
      ),
      ...this.textBlock('Input', b.input),
      ...(b.status === 'pending' ? [] : this.textBlock('Output', b.output || '(empty)')),
    ];
  }

  private harnessCard(
    turn: ConversationTurn,
    placed: readonly { readonly item: ContextItem; readonly index: number }[],
  ): HTMLElement {
    const items = placed.map((p) => p.item);
    const at = placed[0]?.index ?? 0;
    const tokens = items.reduce((sum, i) => sum + i.tokens, 0);
    const sources = new Map<string, number>();
    for (const i of items) sources.set(i.source, (sources.get(i.source) ?? 0) + 1);
    const key = `harness:${turn.n}:${at}`;
    const card = el('div', { class: 'cv-card cv-harness' });
    card.append(
      this.row(
        key,
        [
          el('span', { class: 'name' }, 'Harness'),
          el('span', { class: 'what' }, [...sources].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(', ')),
          el('span', { class: 'meta' }, `${count(items.length, 'item')} · ~${kTok(tokens)} tokens`),
        ],
        () =>
          placed.map(({ item, index }) =>
            this.row(
              `context:${turn.n}:${index}`,
              [
                el('span', { class: 'chip' }, item.source),
                el('span', { class: 'what' }, item.label),
                el('span', { class: 'meta' }, `${this.stamp(item.ts)} · ~${kTok(item.tokens)}`),
              ],
              () => this.textBlock('What the model saw', item.text),
              { hidden: item.text, attrs: { 'data-item': `${turn.n}.${index}` } },
            ),
          ),
        {
          hidden: items.map((i) => `${i.label}\n${i.text}`).join('\n'),
          attrs: {
            'data-turn': String(turn.n),
            'data-from': String(at),
            'data-to': String(placed[placed.length - 1]?.index ?? at),
          },
        },
      ),
    );
    return card;
  }

  private compactionCard(c: CompactionItem): HTMLElement {
    const sizes =
      c.preTokens !== null || c.postTokens !== null
        ? `${c.preTokens === null ? '?' : kTok(c.preTokens)} → ${c.postTokens === null ? '?' : kTok(c.postTokens)} tokens`
        : '';
    return el(
      'div',
      { class: 'cv-card cv-compaction' },
      this.row(
        `compaction:${c.ts}`,
        [
          el('span', { class: 'name' }, 'Compaction'),
          el('span', { class: 'what' }, present([c.trigger, sizes]).join(' · ')),
          el('span', { class: 'meta' }, this.stamp(c.ts)),
        ],
        c.summary ? () => this.textBlock('Summary', c.summary) : null,
        { hidden: c.summary },
      ),
    );
  }

  private noticeLine(n: NoticeItem): HTMLElement {
    return el(
      'div',
      { class: `cv-notice ${n.level}` },
      el('span', { class: `chip${n.level === 'info' ? '' : ' fail'}` }, n.level),
      el('span', {}, ...this.marked(n.text)),
      el('span', { class: 'muted' }, this.stamp(n.ts)),
    );
  }

  private resultCard(r: ResultItem): HTMLElement {
    return el(
      'div',
      { class: 'cv-card' },
      this.row(
        `result:${r.id}:${r.ts}`,
        [
          el('span', { class: 'name' }, 'Result'),
          el('span', { class: 'what' }, `for a call this thread did not ask for (${r.id})`),
          r.status === 'ok' ? null : el('span', { class: 'chip fail' }, r.status),
        ],
        () => this.textBlock('Output', r.output),
        { hidden: r.output },
      ),
    );
  }

  // ---------- findings ----------

  /** The findings rail: the shown thread's findings, or every thread's. */
  private renderFindings(): void {
    const others = this.threads.filter((t) => t !== this.thread && t.findings.length > 0);
    if (!others.length) this.allFindings = false;
    const threads = this.allFindings ? this.threads.filter((t) => t.findings.length > 0) : [this.thread];
    const total = this.threads.reduce((n, t) => n + t.findings.length, 0);
    let scope: HTMLSelectElement | null = null;
    if (others.length) {
      scope = el(
        'select',
        { 'aria-label': 'Findings of' },
        el('option', { value: 'thread' }, 'This thread'),
        el('option', { value: 'all' }, `All threads (${total})`),
      );
      scope.value = this.allFindings ? 'all' : 'thread';
      scope.addEventListener('change', () => {
        this.allFindings = scope?.value === 'all';
        this.renderFindings();
      });
    }
    const shown = threads.reduce((n, t) => n + t.findings.length, 0);
    const parts: Child[] = [
      el(
        'div',
        { class: 'cv-findings-head muted' },
        el('span', { class: 't' }, 'Findings'),
        el('span', {}, String(shown)),
        scope,
      ),
    ];
    if (!shown)
      parts.push(
        el(
          'div',
          { class: 'cv-findings-empty muted' },
          'Nothing stood out: no retries, refusals, repeated reads or text, large outputs, or cache rebuilds.',
        ),
      );
    for (const t of threads) {
      if (this.allFindings && t.findings.length)
        parts.push(
          el(
            'div',
            { class: 'cv-findings-thread' },
            t === this.thread
              ? t.label
              : el(
                  'a',
                  {
                    href: targetHash({ lane: t.id }),
                    onclick: (e) => {
                      e.preventDefault();
                      this.show(t, { lane: t.id });
                    },
                  },
                  t.label,
                ),
          ),
        );
      for (const f of t.findings) parts.push(this.findingCard(t, f));
    }
    this.els.findings.replaceChildren(...nodes(parts));
  }

  private findingCard(t: Thread, f: Finding): HTMLElement {
    const card = el('details', { class: 'cv-finding' });
    const step = (dir: 1 | -1): void => {
      this.stepping = this.stepping?.finding === f ? this.stepping : { finding: f, at: dir > 0 ? -1 : 0 };
      this.stepPlace(dir);
    };
    const places = f.at.slice(0, PLACES_SHOWN).map((r, i) =>
      el(
        'a',
        {
          href: targetHash(
            r.tool === null ? { lane: t.id, item: `${r.turn}.${r.item}` } : { lane: t.id, tool: r.tool },
          ),
          'data-place': i,
          title: r.label,
          onclick: (e) => {
            e.preventDefault();
            this.stepping = { finding: f, at: i };
            this.goToPlace(t, r);
          },
        },
        el('span', { class: 'n' }, r.turn === 0 ? '·' : `T${r.turn}`),
        r.label,
      ),
    );
    const setup = f.kind === 'unused-tools' || f.kind === 'shape-change';
    card.append(
      ...nodes([
        el(
          'summary',
          {},
          el('span', { class: `cv-sev ${f.severity}` }, f.severity),
          el('span', { class: 't' }, f.title),
          el(
            'span',
            { class: 'meta' },
            f.tokens === null ? (f.at.length ? String(f.at.length) : '') : `~${kTok(f.tokens)}`,
          ),
        ),
        el('p', { class: 'd' }, f.detail),
        f.at.length > 1
          ? el(
              'div',
              { class: 'cv-step' },
              el(
                'button',
                {
                  type: 'button',
                  onclick: () => {
                    step(-1);
                  },
                },
                '‹ Previous',
              ),
              el(
                'button',
                {
                  type: 'button',
                  onclick: () => {
                    step(1);
                  },
                },
                'Next ›',
              ),
              el('span', { class: 'muted' }, `${count(f.at.length, 'place')} · N steps through them`),
            )
          : null,
        places.length ? el('div', { class: 'cv-places' }, ...places) : null,
        f.at.length > PLACES_SHOWN
          ? el('div', { class: 'cv-findings-empty muted' }, `and ${f.at.length - PLACES_SHOWN} more`)
          : null,
        setup && t.shapes.length
          ? el(
              'div',
              { class: 'cv-step' },
              el(
                'button',
                {
                  type: 'button',
                  onclick: () => {
                    if (t !== this.thread) this.show(t, { lane: t.id });
                    this.openSetup(null);
                  },
                },
                'Open the system prompt and tools',
              ),
            )
          : null,
      ]),
    );
    card.addEventListener('toggle', () => {
      if (card.open) this.stepping = { finding: f, at: -1 };
    });
    return card;
  }

  /** Shows a place of a finding: its thread, then the item or the tool call. */
  private goToPlace(t: Thread, r: FindingRef): void {
    if (t !== this.thread) this.show(t);
    this.reveal(r.tool === null ? { lane: t.id, item: `${r.turn}.${r.item}` } : { lane: t.id, tool: r.tool });
    for (const a of queryAll('.cv-places a.on', HTMLAnchorElement, this.els.findings)) a.classList.remove('on');
    const at = this.stepping?.finding.at.indexOf(r) ?? -1;
    const card = [...queryAll('.cv-finding', HTMLDetailsElement, this.els.findings)].find((c) => c.open);
    card?.querySelector(`[data-place="${at}"]`)?.classList.add('on');
  }

  /** Steps to the next (1) or previous (-1) place of the finding being stepped through, or of the first open one. */
  private stepPlace(dir: 1 | -1): void {
    if (this.stepping === null) {
      const threads = this.allFindings ? this.threads : [this.thread];
      const first = threads.flatMap((t) => t.findings).find((f) => f.at.length > 0);
      if (first === undefined) return;
      this.stepping = { finding: first, at: -1 };
    }
    const { finding } = this.stepping;
    if (!finding.at.length) return;
    const t = this.byId.get(finding.thread);
    if (t === undefined) return;
    const n = finding.at.length;
    this.stepping.at = (((this.stepping.at + dir) % n) + n) % n;
    const r = finding.at[this.stepping.at];
    if (r !== undefined) this.goToPlace(t, r);
  }

  // ---------- the system prompt and tools ----------

  private renderSetupButton(): void {
    const t = this.thread;
    const b = this.els.setupOpen;
    const shapes = present(t.shapes.map((x) => this.shapes.get(x.id)));
    b.hidden = !shapes.length;
    const last = shapes[shapes.length - 1];
    if (last !== undefined)
      b.textContent = `System prompt and tools · ~${kTok(last.systemTokens + last.toolTokens)} tokens${shapes.length > 1 ? ` · ${shapes.length} versions` : ''}`;
  }

  private closeSetup(): void {
    this.setupShape = null;
    this.els.setup.hidden = true;
  }

  /** Opens the drawer on one of the shown thread's shapes, its last by default. */
  private openSetup(id: string | null): void {
    const t = this.thread;
    const used = t.shapes.filter((x) => this.shapes.has(x.id));
    const current = used.find((x) => x.id === id) ?? used[used.length - 1];
    const shape = current === undefined ? undefined : this.shapes.get(current.id);
    if (current === undefined || shape === undefined) {
      this.closeSetup();
      return;
    }
    this.setupShape = shape.id;
    this.els.setup.hidden = false;
    this.els.setupSub.textContent = t.label;
    const index = used.indexOf(current);
    const before = index > 0 ? used[index - 1] : undefined;
    const previous = before === undefined ? undefined : this.shapes.get(before.id);
    const called = calledTools(t);
    const first = modelCalls(t).find((m) => m.id === current.first);
    const deferred = shape.tools.filter((d) => d.deferred).length;
    const unused = shape.tools.filter((d) => !d.deferred && !called.has(d.name));
    const unusedTokens = unused.reduce((sum, d) => sum + d.tokens, 0);

    const parts: Child[] = [];
    const settings = settingsOf(t);
    if (settings.length)
      parts.push(
        el('h3', {}, 'Request settings'),
        el(
          'table',
          {},
          el('tr', {}, el('th', {}, 'Sent with'), el('th', {}, 'Calls')),
          ...settings.map((x) => el('tr', {}, el('td', {}, x.label), el('td', {}, String(x.calls)))),
        ),
      );
    const recorded = settings.reduce((n, x) => n + x.calls, 0);
    if (settings.length && recorded < t.stats.calls)
      parts.push(
        el(
          'p',
          { class: 'muted' },
          `The agent recorded the requests of ${recorded} of the thread's ${count(t.stats.calls, 'model call')}.`,
        ),
      );
    if (used.length > 1) {
      const pick = el(
        'select',
        { 'aria-label': 'Version' },
        ...used.map((x, i) =>
          el('option', { value: x.id }, `Version ${i + 1} · from ${this.stamp(x.ts)} · ${count(x.calls, 'call')}`),
        ),
      );
      pick.value = current.id;
      pick.addEventListener('change', () => {
        this.openSetup(pick.value);
      });
      parts.push(el('h3', {}, 'Version'), pick);
      if (previous !== undefined) {
        const changes = shapeChanges(previous, shape);
        parts.push(
          el(
            'p',
            { class: 'cv-budget' },
            `Changed from version ${index}: ${changes.length ? changes.join('; ') : 'no difference in what is shown'}.`,
          ),
        );
      }
    }
    parts.push(
      el(
        'p',
        { class: 'cv-budget' },
        `System prompt ~${kTok(shape.systemTokens)} tokens in ${count(shape.system.length, 'block')} · ${count(shape.tools.length - deferred, 'tool')} ~${kTok(shape.toolTokens)} tokens` +
          (deferred ? ` (and ${deferred} deferred, loaded only when looked for)` : '') +
          (first?.context != null
            ? ` · together about ${Math.round((100 * (shape.systemTokens + shape.toolTokens)) / first.context)}% of the ${kTok(first.context)} tokens its first call read`
            : '') +
          (unused.length
            ? ` · ${count(unused.length, 'tool')} never called in this thread, ~${kTok(unusedTokens)} tokens`
            : ''),
      ),
      el('p', { class: 'muted' }, 'Sizes are estimated at four characters a token.'),
      el('h3', {}, 'System prompt'),
      el(
        'div',
        { class: 'cv-card' },
        ...shape.system.map((b, i) =>
          this.row(
            `setup:${shape.id}:system:${i}`,
            [
              el('span', { class: 'name' }, `Block ${i + 1}`),
              el('span', { class: 'what' }, oneLine(b.text, 140)),
              el('span', { class: 'meta' }, `~${kTok(b.tokens)}`),
            ],
            () => this.textBlock('Text', b.text),
            { hidden: b.text },
          ),
        ),
      ),
      el('h3', {}, 'Tools, largest first'),
      el(
        'div',
        { class: 'cv-card' },
        ...[...shape.tools]
          .sort((x, y) => y.tokens - x.tokens)
          .map((d) =>
            this.row(
              `setup:${shape.id}:tool:${d.name}`,
              [
                el('span', { class: 'cv-key tool' }),
                el('span', { class: 'name' }, d.name),
                el('span', { class: 'what' }, oneLine(d.description, 140)),
                d.deferred ? el('span', { class: 'chip' }, 'deferred') : null,
                !d.deferred && !called.has(d.name) ? el('span', { class: 'chip' }, 'never called') : null,
                el('span', { class: 'meta' }, `~${kTok(d.tokens)}`),
              ],
              () => [...this.textBlock('Description', d.description), ...this.textBlock('Input schema', d.schema)],
              { hidden: `${d.description}\n${d.schema}` },
            ),
          ),
      ),
    );
    this.els.setupBody.replaceChildren(...nodes(parts));
  }

  // ---------- keys ----------

  private bindKeys(): void {
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (e.key === 'Escape' && this.setupShape !== null) {
        this.closeSetup();
        return;
      }
      if (e.key === 'Escape' && e.target === this.els.q) {
        this.els.q.value = '';
        this.setState({ ...this.state, query: '' });
        this.els.q.blur();
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        this.els.q.focus();
      } else if (e.key === 'j' || e.key === 'k') this.stepTurn(e.key === 'j' ? 1 : -1);
      else if (e.key === 'f') this.nextFailure();
      else if (e.key === 'n') this.stepPlace(1);
    });
  }

  /** Scrolls to the next (1) or previous (-1) turn. */
  private stepTurn(dir: 1 | -1): void {
    const sections = queryAll('.cv-turn', HTMLElement, this.els.stream);
    const tops = sections.map((s) => s.getBoundingClientRect().top);
    const i = dir > 0 ? tops.findIndex((top) => top > 8) : tops.reduce((found, top, at) => (top < -8 ? at : found), -1);
    sections[i]?.scrollIntoView({ block: 'start' });
  }

  /** Shows the next failed, interrupted, or refused tool call below the top of the window, or the first. */
  private nextFailure(): void {
    const rows = queryAll('.cv-failure', HTMLElement, this.els.stream);
    const next = rows.find((r) => r.getBoundingClientRect().top > window.innerHeight / 2 + 4) ?? rows[0];
    if (next) this.flash(next);
  }
}

/** How to open each row from outside it: by its wrapper. */
const wrapFills = new WeakMap<HTMLElement, () => void>();
