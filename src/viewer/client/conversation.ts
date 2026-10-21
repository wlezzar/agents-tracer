import type {
  CompactionItem,
  ContextItem,
  ConversationData,
  ConversationItem,
  ConversationTurn,
  ModelItem,
  NoticeItem,
  PromptItem,
  ResultItem,
  Thread,
  ToolBlock,
} from '../../view/types.js';
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
import { byId, copyButton, el, nodes, present, queryAll, type Child } from './dom.js';
import { fmt, kTok, oneLine, spansDays, stamp } from './format.js';
import { parseTarget, targetHash, type Target } from './links.js';
import { applyTheme, cycleTheme } from './theme.js';

// The conversation page: one thread at a time (the main session's or an agent's), turn by turn,
// with an outline of the turns, a chart of the context, and filters. A tool call, a reasoning, the
// harness's context, or a compaction's summary is one row until it is opened; what an opened row
// shows is built when it is first opened, so that a long thread stays quick.

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
  readonly multiDay: boolean;
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
    tip: byId('tip', HTMLDivElement),
  };
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private spy: IntersectionObserver | undefined;

  constructor(data: ConversationData) {
    this.data = data;
    this.threads = data.conversation.threads;
    this.byId = new Map(this.threads.map((t) => [t.id, t]));
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
    byId('cv-back', HTMLAnchorElement).hidden = data.serve !== true;
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
      ...this.threads.map((t) =>
        el(
          'option',
          { value: t.id },
          t.id === 'main'
            ? `${t.label} · ${count(t.stats.calls, 'model call')}`
            : `${t.parent !== null && t.parent !== 'main' ? '↳ ' : ''}${t.phase ? `${t.phase} · ` : ''}${t.label}${t.agentType ? ` (${t.agentType})` : ''}`,
        ),
      ),
    );
    els.threadSelect.disabled = this.threads.length < 2;
    els.threadSelect.addEventListener('change', () => {
      const t = this.byId.get(els.threadSelect.value);
      if (t) this.show(t, { lane: t.id });
    });
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

  // ---------- threads and state ----------

  /** Shows a thread, then what `target` points at in it. */
  show(t: Thread, target: Target | null = null): void {
    const changed = t !== this.thread || !this.els.stream.hasChildNodes();
    this.thread = t;
    this.els.threadSelect.value = t.id;
    if (changed) {
      this.renderStats();
      this.renderLaunch();
      this.renderChart();
      this.renderStream();
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

  /** Opens and shows the call `target` points at, clearing a filter that hides it. */
  reveal(target: Target): void {
    const selector =
      'tool' in target
        ? `[data-tool="${CSS.escape(target.tool)}"]`
        : 'model' in target
          ? `[data-model="${CSS.escape(target.model)}"]`
          : null;
    if (selector === null) return;
    let node = this.els.stream.querySelector(selector);
    if (node === null && !showsAll(this.state)) {
      this.els.q.value = '';
      this.els.filter.value = 'all';
      this.els.harness.checked = true;
      this.state = { filter: 'all', query: '', harness: true };
      this.renderStream();
      node = this.els.stream.querySelector(selector);
    }
    if (!(node instanceof HTMLElement)) return;
    if ('tool' in target) {
      this.open.add(`tool:${target.tool}`);
      this.fill(node);
    }
    this.flash(node);
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
    let harness: ContextItem[] = [];
    const flush = (): void => {
      if (harness.length) body.push(this.harnessCard(turn, harness));
      harness = [];
    };
    turn.items.forEach((item) => {
      const change =
        item.type === 'model' && item.context !== null && previous !== null ? item.context - previous : null;
      if (item.type === 'model' && item.context !== null) previous = item.context;
      if (!itemShown(item, this.state)) return;
      if (item.type === 'context') {
        harness.push(item);
        return;
      }
      flush();
      body.push(this.itemCard(item, change));
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
            { title: 'Tokens the call read: input, cache reads, and cache writes' },
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

  private harnessCard(turn: ConversationTurn, items: readonly ContextItem[]): HTMLElement {
    const first = items[0];
    const at = first === undefined ? 0 : turn.items.indexOf(first);
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
          items.map((item, i) =>
            this.row(
              `context:${turn.n}:${at + i}`,
              [
                el('span', { class: 'chip' }, item.source),
                el('span', { class: 'what' }, item.label),
                el('span', { class: 'meta' }, `${this.stamp(item.ts)} · ~${kTok(item.tokens)}`),
              ],
              () => this.textBlock('What the model saw', item.text),
              { hidden: item.text },
            ),
          ),
        { hidden: items.map((i) => `${i.label}\n${i.text}`).join('\n') },
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

  // ---------- keys ----------

  private bindKeys(): void {
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
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
