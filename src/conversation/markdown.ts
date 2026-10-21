import { clip, clock, day, fmt, kTok, spansDays } from '../util/index.js';
import type {
  CompactionItem,
  ContextItem,
  Conversation,
  ConversationBlock,
  ConversationItem,
  ConversationTurn,
  Finding,
  ModelItem,
  Permission,
  Shape,
  Thread,
  ToolBlock,
  ToolStatus,
} from './types.js';

// A session's conversation as Markdown, for reading it in an editor or handing it to an agent:
// a header with the session's numbers, then each thread's turns, in which the prompts and the
// model's texts are quoted (so that their own headings stay inside them) and inputs, outputs, and
// the harness's context are fenced.

/** How to write the Markdown. */
export interface MarkdownOptions {
  /** Write the text of the harness's context items; by default each is one line with its size. */
  readonly context?: boolean;
  /** The most characters of each input, output, reasoning, context item, and summary, head and tail kept; 0 keeps all. */
  readonly maxOutput?: number;
  /** Write the agents' threads after the main one; true by default. */
  readonly subagents?: boolean;
  /** Only this turn of the main thread, and the agents its tool calls launched. */
  readonly turn?: number;
  /** List what looks worth improving before the threads; true by default. */
  readonly findings?: boolean;
  /** Write the system prompt and the tools' definitions each thread's model calls were sent with. */
  readonly setup?: boolean;
}

/** The most places a finding lists. */
const FINDING_PLACES = 10;

/** The default of {@link MarkdownOptions.maxOutput}. */
export const MAX_OUTPUT = 3000;

/** `text` in a fenced block, with a fence longer than any run of backticks it holds. */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const bar = '`'.repeat(Math.max(3, longest + 1));
  return `${bar}${lang}\n${text.replace(/\n$/, '')}\n${bar}`;
}

/** `text` as a block quote, every line of it. */
export function quote(text: string): string {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** A count and its noun, plural unless it is one: `1 item`, `3 items`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A token delta, signed: `+1.2k`, `−40.0k`. */
function delta(n: number): string {
  return n < 0 ? `−${kTok(-n)}` : `+${kTok(n)}`;
}

const STATUS: Readonly<Record<ToolStatus, string>> = {
  ok: '',
  error: 'failed',
  interrupted: 'interrupted',
  pending: 'no result',
};

/** How a call was let run, when it says something: a refusal, or the person's go-ahead. */
function permissionText(p: Permission | null): string {
  if (p === null) return '';
  if (!p.allowed) return p.by === 'you' ? 'you refused it' : `refused (${p.by})`;
  return p.by === 'you' ? 'you allowed it' : '';
}

/** Writes one session's conversation; `time` formats a time as the session needs it. */
class Writer {
  readonly lines: string[] = [];
  private readonly options: MarkdownOptions;
  private readonly time: (ts: number) => string;
  private readonly threads: ReadonlyMap<string, Thread>;
  private readonly cut: (text: string) => string;
  private readonly shapes: ReadonlyMap<string, Shape>;
  /** The shapes written in full, and the thread that wrote each. */
  private readonly written = new Map<string, string>();

  constructor(
    options: MarkdownOptions,
    time: (ts: number) => string,
    threads: ReadonlyMap<string, Thread>,
    shapes: ReadonlyMap<string, Shape>,
  ) {
    this.options = options;
    this.time = time;
    this.threads = threads;
    this.shapes = shapes;
    const max = options.maxOutput ?? MAX_OUTPUT;
    this.cut = (text) => (max > 0 ? clip(text, max) : text);
  }

  /** A paragraph, set apart from the ones around it. */
  add(...paragraphs: string[]): void {
    for (const p of paragraphs) this.lines.push(p, '');
  }

  /** What looks worth improving in `threads`, in a turn when `turn` is given. */
  findings(threads: readonly Thread[], turn: number | undefined): void {
    const lists = threads.flatMap((t) => {
      const list = t.findings.flatMap((f): Finding[] => {
        if (turn === undefined || t.id !== 'main') return [f];
        const at = f.at.filter((r) => r.turn === turn);
        return at.length ? [{ ...f, at }] : [];
      });
      return list.length ? [{ t, list }] : [];
    });
    this.add('## Findings');
    if (!lists.length) {
      this.add('Nothing stood out.');
      return;
    }
    this.add(
      'Leads to read, not verdicts: patterns that often cost tokens, time, or attention, with where each happened (turn, and the tool call’s id).',
    );
    for (const { t, list } of lists) {
      if (threads.length > 1) this.add(t.id === 'main' ? `### ${t.label}` : `### Agent: ${t.label} (\`${t.id}\`)`);
      const lines = list.map((f) => {
        const tokens = f.tokens === null ? '' : ` (~${kTok(f.tokens)} tokens)`;
        const places = f.at.slice(0, FINDING_PLACES).map((r) => {
          const where = r.turn === 0 ? 'Before the first prompt' : `Turn ${r.turn}`;
          return `  - ${where} · ${r.label}${r.tool === null ? '' : ` (\`${r.tool}\`)`}`;
        });
        if (f.at.length > FINDING_PLACES) places.push(`  - and ${f.at.length - FINDING_PLACES} more`);
        return [`- **${f.severity}** · ${f.title}${tokens}. ${f.detail}`, ...places].join('\n');
      });
      this.add(lines.join('\n'));
    }
  }

  /** What a thread's model calls were sent with: their settings, and the system prompt and tools. */
  private setup(t: Thread): void {
    const settings = new Map<string, number>();
    for (const turn of t.turns)
      for (const i of turn.items)
        if (i.type === 'model' && i.request !== null) {
          const r = i.request;
          const k = [
            r.model,
            r.effort !== null && `effort ${r.effort}`,
            r.maxTokens !== null && `max ${r.maxTokens} tokens`,
            r.thinking !== null && `thinking ${r.thinking}`,
          ]
            .filter((x) => typeof x === 'string' && x !== '')
            .join(', ');
          if (k) settings.set(k, (settings.get(k) ?? 0) + 1);
        }
    const lines = [...settings].map(([k, n]) => `- Sent with ${k} (${count(n, 'call')})`);
    for (const used of t.shapes) {
      const s = this.shapes.get(used.id);
      if (s === undefined) continue;
      const deferred = s.tools.filter((d) => d.deferred).length;
      lines.push(
        `- ${t.shapes.length > 1 ? `From ${this.time(used.ts)}, ${count(used.calls, 'call')}: s` : 'S'}ystem prompt ~${kTok(s.systemTokens)} tokens in ${count(s.system.length, 'block')}; ${count(s.tools.length - deferred, 'tool')} ~${kTok(s.toolTokens)} tokens${deferred ? ` (and ${deferred} deferred)` : ''}: ${s.tools
          .filter((d) => !d.deferred)
          .map((d) => d.name)
          .join(', ')}`,
      );
    }
    if (lines.length) this.add(lines.join('\n'));
    if (!this.options.setup) return;
    for (const used of t.shapes) {
      const s = this.shapes.get(used.id);
      if (s === undefined) continue;
      const by = this.written.get(s.id);
      if (by !== undefined) {
        this.add(`The system prompt and tools from ${this.time(used.ts)} are the same as ${by}’s.`);
        continue;
      }
      this.written.set(s.id, t.id === 'main' ? 'the main session' : `agent \`${t.id}\``);
      this.add(`### System prompt and tools${t.shapes.length > 1 ? ` from ${this.time(used.ts)}` : ''}`);
      s.system.forEach((b, i) => {
        this.add(`#### System prompt, block ${i + 1} · ~${kTok(b.tokens)} tokens`, fence(this.cut(b.text)));
      });
      for (const d of [...s.tools].sort((x, y) => y.tokens - x.tokens))
        this.add(
          `#### Tool ${d.name} · ~${kTok(d.tokens)} tokens${d.deferred ? ' · deferred' : ''}`,
          quote(this.cut(d.description) || '(no description)'),
          fence(this.cut(d.schema), 'json'),
        );
    }
  }

  thread(t: Thread, turns: readonly ConversationTurn[]): void {
    const facts = [
      t.agentType,
      t.phase && `phase ${t.phase}`,
      t.background && 'background',
      t.start !== null && t.end !== null && `${this.time(t.start)} → ${this.time(t.end)}`,
      `wall ${fmt(t.stats.wall)}`,
      `active ${fmt(t.stats.active)}`,
    ].filter((f) => typeof f === 'string' && f !== '');
    this.add(t.id === 'main' ? `## ${t.label}` : `## Agent: ${t.label} (\`${t.id}\`)`, facts.join(' · '));
    if (t.parent !== null) {
      const parent = this.threads.get(t.parent);
      this.add(
        `Launched by ${t.launcher === null ? 'a tool call' : `tool call \`${t.launcher}\``} of ${parent === undefined ? `\`${t.parent}\`` : parent.id === 'main' ? 'the main session' : `agent \`${parent.id}\``}.`,
      );
    }
    this.setup(t);
    let previous: number | null = null;
    for (const turn of turns) {
      this.add(
        turn.n === 0
          ? '### Before the first prompt'
          : `### Turn ${turn.n} · ${turn.kind ?? ''} · ${this.time(turn.ts)} · active ${fmt(turn.active)}`,
      );
      let harness: ContextItem[] = [];
      const flush = (): void => {
        if (harness.length) this.harness(harness);
        harness = [];
      };
      for (const item of turn.items) {
        if (item.type === 'context') {
          harness.push(item);
          continue;
        }
        flush();
        if (item.type === 'model') {
          this.model(item, item.context !== null && previous !== null ? item.context - previous : null);
          if (item.context !== null) previous = item.context;
        } else this.item(item, t.id !== 'main');
      }
      flush();
    }
  }

  private harness(items: readonly ContextItem[]): void {
    const tokens = items.reduce((sum, i) => sum + i.tokens, 0);
    const head = `#### Harness · ${count(items.length, 'item')} · ~${kTok(tokens)} tokens`;
    if (!this.options.context) {
      this.add(head, items.map((i) => `- ${i.source}: ${i.label} (~${kTok(i.tokens)} tokens)`).join('\n'));
      return;
    }
    this.add(head);
    for (const i of items) this.add(`**${i.source}: ${i.label}** (~${kTok(i.tokens)} tokens)`, fence(this.cut(i.text)));
  }

  private item(item: Exclude<ConversationItem, ContextItem | ModelItem>, agent: boolean): void {
    switch (item.type) {
      case 'prompt': {
        // An agent's prompts come from the agent that launched it, not from the person.
        const who =
          item.by === 'task'
            ? 'Task report'
            : item.by === 'command'
              ? 'Command'
              : item.origin !== null
                ? `Prompt (${item.origin})`
                : agent
                  ? 'Prompt'
                  : 'You';
        const images = item.images ? ` · ${count(item.images, 'image')}` : '';
        this.add(`#### ${who} · ${this.time(item.ts)}${images}`);
        if (item.summary !== null) this.add(`Summary: ${item.summary}`);
        this.add(item.text.trim() ? quote(item.text) : '*(no text)*');
        break;
      }
      case 'compaction':
        this.compaction(item);
        break;
      case 'notice':
        this.add(`> **${item.level}** · ${this.time(item.ts)} · ${item.text.replace(/\n/g, ' ')}`);
        break;
      case 'result':
        this.add(
          `#### Result for an unknown call \`${item.id}\` · ${this.time(item.ts)}${item.status === 'ok' ? '' : ` · ${STATUS[item.status]}`}`,
          fence(this.cut(item.output)),
        );
        break;
    }
  }

  private compaction(item: CompactionItem): void {
    const sizes =
      item.preTokens !== null || item.postTokens !== null
        ? ` · ${item.preTokens === null ? '?' : kTok(item.preTokens)} → ${item.postTokens === null ? '?' : kTok(item.postTokens)} tokens`
        : '';
    this.add(`#### Compaction · ${this.time(item.ts)}${item.trigger === null ? '' : ` · ${item.trigger}`}${sizes}`);
    if (item.summary) this.add(fence(this.cut(item.summary)));
  }

  private model(item: ModelItem, change: number | null): void {
    const facts = [
      item.model,
      this.time(item.ts),
      fmt(item.ms),
      item.context !== null && `context ${kTok(item.context)}${change === null ? '' : ` (${delta(change)})`}`,
      item.out !== null && `${kTok(item.out)} out`,
      item.stop !== null && item.stop !== 'end_turn' && item.stop !== 'tool_use' && `stop: ${item.stop}`,
      item.error ? 'API error' : item.synthetic && 'written by the agent',
    ].filter((f) => typeof f === 'string' && f !== '');
    this.add(`#### Model · ${facts.join(' · ')}`);
    for (const b of item.blocks) this.block(b);
  }

  private block(b: ConversationBlock): void {
    switch (b.type) {
      case 'thinking': {
        const ms = b.ms === null ? '' : ` (${fmt(b.ms)})`;
        if (b.text) this.add(`*Thinking${ms}:*`, quote(this.cut(b.text)));
        else this.add(`*Thinking${ms}, ${b.redacted ? 'redacted' : 'not recorded'}.*`);
        break;
      }
      case 'text':
        if (b.text.trim()) this.add(quote(b.text));
        break;
      case 'other':
        this.add(`*${b.label}:*`, fence(this.cut(b.text)));
        break;
      case 'tool':
        this.tool(b);
        break;
    }
  }

  private tool(b: ToolBlock): void {
    const facts = [
      b.purpose,
      b.detail && `\`${b.detail.replace(/`/g, "'")}\``,
      b.ms !== null && fmt(b.ms),
      STATUS[b.status],
      b.async && 'background',
      permissionText(b.permission),
    ].filter((f) => typeof f === 'string' && f !== '');
    this.add(`##### ${b.name}${facts.length ? ` · ${facts.join(' · ')}` : ''}`);
    if (b.input) this.add(b.category === 'shell' ? fence(this.cut(b.input), 'sh') : fence(this.cut(b.input)));
    if (b.agent !== null) {
      const agent = this.threads.get(b.agent);
      this.add(`Its conversation: Agent: ${agent?.label ?? b.agent} (\`${b.agent}\`).`);
    }
    if (b.status !== 'pending') {
      const images = b.images ? `, ${count(b.images, 'image')}` : '';
      this.add(`Result (~${kTok(b.tokens)} tokens${images}):`, fence(this.cut(b.output)));
    }
  }
}

/** The threads to write: the main one, and the agents unless left out, or only those a turn launched. */
function chosen(conversation: Conversation, options: MarkdownOptions): readonly Thread[] {
  const [main, ...agents] = conversation.threads;
  if (main === undefined) return [];
  if (options.subagents === false) return [main];
  if (options.turn === undefined) return conversation.threads;
  const turn = main.turns.find((t) => t.n === options.turn);
  const launched = new Set(
    (turn?.items ?? [])
      .flatMap((i) => (i.type === 'model' ? i.blocks : []))
      .flatMap((b) => (b.type === 'tool' && b.agent !== null ? [b.agent] : [])),
  );
  // And the agents those agents launched, however deep.
  for (let grew = true; grew;) {
    grew = false;
    for (const a of agents)
      if (!launched.has(a.id) && a.parent !== null && launched.has(a.parent)) {
        launched.add(a.id);
        grew = true;
      }
  }
  return [main, ...agents.filter((a) => launched.has(a.id))];
}

/** A session's conversation as Markdown. */
export function markdown(conversation: Conversation, options: MarkdownOptions = {}): string {
  const { session, threads } = conversation;
  const [main] = threads;
  const multiDay = main?.start != null && main.end != null && spansDays(main.start, main.end);
  const writer = new Writer(
    options,
    (ts) => clock(ts, multiDay),
    new Map(threads.map((t) => [t.id, t])),
    new Map(conversation.shapes.map((s) => [s.id, s])),
  );
  writer.add(`# ${session.title ?? `Session ${session.id}`}`);
  if (main !== undefined) {
    const s = main.stats;
    const sub = threads.length - 1;
    writer.add(
      [
        `- Session: \`${session.id}\``,
        session.cwd !== null && `- Directory: \`${session.cwd}\``,
        main.start !== null && main.end !== null && `- Time: ${day(main.start)} → ${day(main.end)}`,
        `- Wall ${fmt(s.wall)} · active ${fmt(s.active)} (model ${fmt(s.model)}, tools ${fmt(s.tools)}, you ${fmt(s.you)})`,
        `- ${count(s.calls, 'model call')} · ${count(s.toolCalls, 'tool call')} (${s.failed} failed or interrupted, ${s.denied} refused)` +
          (s.peakContext === null ? '' : ` · peak context ${kTok(s.peakContext)} tokens`) +
          (s.out === null ? '' : ` · ${kTok(s.out)} output tokens`) +
          (s.compactions ? ` · ${count(s.compactions, 'compaction')}` : ''),
        `- Harness context: ${count(s.contextItems, 'item')}, ~${kTok(s.contextTokens)} tokens (estimated at four characters a token)`,
        sub > 0 && `- ${count(sub, 'agent')}`,
      ]
        .filter((l) => typeof l === 'string')
        .join('\n'),
    );
  }
  const shown = chosen(conversation, options);
  if (options.findings !== false) writer.findings(shown, options.turn);
  for (const t of shown) {
    const turns = t === main && options.turn !== undefined ? t.turns.filter((x) => x.n === options.turn) : t.turns;
    writer.thread(t, turns);
  }
  return writer.lines.join('\n').replace(/\n+$/, '\n');
}
