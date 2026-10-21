import { estimateTokens, fmt, kTok, oneLine } from '../util/index.js';
import type {
  ContextItem,
  ConversationItem,
  Finding,
  FindingKind,
  FindingRef,
  ModelItem,
  Severity,
  Shape,
  Thread,
  ToolBlock,
} from './types.js';

// What looks worth improving in a thread's harness: the patterns in its conversation that cost
// tokens, time, or the person's attention, such as a failed command made again unchanged, a file
// read again that did not change, or the same reminder added over and over. Each kind is one
// finding with every place it happened, so that the conversation page can step through them and
// the Markdown export can list them. They are leads to read, not verdicts: a retry may have been
// right, and a large output may have been needed.

/** A tool output at least this large (estimated tokens) is large. */
export const LARGE_OUTPUT_TOKENS = 10_000;
/** A model call whose context grew by at least this many tokens since the call before it jumped. */
export const CONTEXT_JUMP_TOKENS = 25_000;
/** A harness item at least this large (estimated tokens) is heavy. */
export const HEAVY_CONTEXT_TOKENS = 5_000;
/** A tool call at least this long (milliseconds) is slow. */
export const SLOW_TOOL_MS = 120_000;
/** A cache rebuilt for fewer tokens than this is not worth a finding. */
const CACHE_MISS_TOKENS = 10_000;
/** How many repeated harness texts are findings of their own; the rest are one. */
const REPEATED_TEXTS = 4;
/** A model call this long after the one before may find the prompt cache lapsed. */
const CACHE_PAUSE_MS = 5 * 60_000;
/** Unused tools whose definitions come to fewer tokens than this are not worth a finding. */
const UNUSED_TOOL_TOKENS = 1_000;

/** Each kind's severity, in the order the findings of one severity are listed. */
const KINDS: readonly (readonly [FindingKind, Severity])[] = [
  ['retry', 'high'],
  ['interrupt', 'high'],
  ['api-error', 'high'],
  ['denied', 'medium'],
  ['failed-edit', 'medium'],
  ['cache-miss', 'medium'],
  ['cache-lapse', 'low'],
  ['shape-change', 'medium'],
  ['repeated-read', 'medium'],
  ['large-output', 'medium'],
  ['repeated-context', 'medium'],
  ['compaction', 'medium'],
  ['context-jump', 'low'],
  ['heavy-context', 'low'],
  ['unused-tools', 'low'],
  ['slow', 'low'],
];
const RANK: ReadonlyMap<FindingKind, number> = new Map(KINDS.map(([k], i) => [k, i]));
const SEVERITY: ReadonlyMap<FindingKind, Severity> = new Map(KINDS);
const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low'];

/** A count and its noun, plural unless it is one. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** How many times: `once`, `twice`, `3 times`. */
function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** An output's first line worth reading, its markup tags dropped. */
function firstLine(text: string): string {
  const line = text
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .find((l) => l.trim());
  return oneLine(line ?? '', 90);
}

/** A tool call in a few words: its tool, and what it did. */
function toolLabel(b: ToolBlock): string {
  const what = oneLine(b.detail || b.preview || b.purpose, 70);
  return what ? `${b.name} · ${what}` : b.name;
}

/** The most common of `values` with how often each came, most first: `a ×3, b ×2`. */
function tally(values: readonly string[], n = 3): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const top = [...counts].sort((x, y) => y[1] - x[1]).slice(0, n);
  const rest = counts.size - top.length;
  return top.map(([v, c]) => (c > 1 ? `${v} ×${c}` : v)).join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

/** An item of a thread, where it is. */
interface Placed<T> {
  readonly turn: number;
  readonly item: number;
  readonly it: T;
}

/** A tool call, where it is. */
interface PlacedTool extends Placed<ModelItem> {
  readonly b: ToolBlock;
}

function ref(p: Placed<unknown>, label: string, tool: string | null = null): FindingRef {
  return { turn: p.turn, item: p.item, tool, label };
}

function toolRef(p: PlacedTool, label = toolLabel(p.b)): FindingRef {
  return ref(p, label, p.b.id);
}

/** What changed from one shape to the next: tools added, removed, loaded, or redefined, and the system prompt. */
function shapeChange(from: Shape | undefined, to: Shape | undefined): string {
  if (from === undefined || to === undefined) return 'the system prompt or the tools changed';
  const before = new Map(from.tools.map((t) => [t.name, t]));
  const after = new Map(to.tools.map((t) => [t.name, t]));
  const added = to.tools.filter((t) => !before.has(t.name)).map((t) => `+${t.name}`);
  const removed = from.tools.filter((t) => !after.has(t.name)).map((t) => `−${t.name}`);
  const loaded: string[] = [];
  const changed: string[] = [];
  for (const t of to.tools) {
    const was = before.get(t.name);
    if (was === undefined) continue;
    if (was.deferred && !t.deferred) loaded.push(t.name);
    else if (was.description !== t.description || was.schema !== t.schema || was.deferred !== t.deferred)
      changed.push(t.name);
  }
  const system = from.system.map((b) => b.text).join('\n') !== to.system.map((b) => b.text).join('\n');
  const tools = [...added, ...removed];
  const parts = [
    tools.length ? oneLine(tools.join(', '), 80) : '',
    loaded.length ? `loaded ${oneLine(loaded.join(', '), 60)}` : '',
    changed.length ? `redefined ${oneLine(changed.join(', '), 60)}` : '',
    system ? 'system prompt changed' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'the request’s shape changed';
}

/** The findings of a thread, most severe first; `shapes` are the conversation's, by id. */
export function findingsOf(t: Omit<Thread, 'findings'>, shapes: ReadonlyMap<string, Shape>): Finding[] {
  const out: Finding[] = [];
  const add = (kind: FindingKind, title: string, detail: string, tokens: number | null, at: FindingRef[]): void => {
    out.push({ kind, severity: SEVERITY.get(kind) ?? 'low', thread: t.id, title, detail, tokens, at });
  };
  const agent = t.id !== 'main';

  // The thread's items in order, where they are.
  const items: Placed<ConversationItem>[] = [];
  for (const turn of t.turns) turn.items.forEach((it, item) => items.push({ turn: turn.n, item, it }));
  const models = items.flatMap((p) => (p.it.type === 'model' ? [{ ...p, it: p.it }] : []));
  const tools: PlacedTool[] = models.flatMap((p) =>
    p.it.blocks.flatMap((b) => (b.type === 'tool' ? [{ ...p, b }] : [])),
  );
  const contexts = items.flatMap((p) => (p.it.type === 'context' ? [{ ...p, it: p.it }] : []));

  // A failed call made again unchanged: the same tool and input, with no file written and no other
  // command run in between that could have changed the outcome.
  {
    const key = (b: ToolBlock): string => `${b.name}\n${b.input}`;
    const at: FindingRef[] = [];
    const seen = new Set<string>();
    const again: string[] = [];
    let tokens = 0;
    tools.forEach((f, i) => {
      if (f.b.status !== 'error') return;
      for (const n of tools.slice(i + 1)) {
        if (key(n.b) === key(f.b)) {
          if (!seen.has(n.b.id)) {
            seen.add(n.b.id);
            at.push(toolRef(n, `${toolLabel(n.b)} · ${n.b.status === 'ok' ? 'then worked' : 'failed again'}`));
            again.push(toolLabel(n.b));
            tokens += n.b.tokens;
          }
          break;
        }
        if (n.b.status === 'ok' && (n.b.file?.access === 'write' || n.b.category === 'shell')) break;
      }
    });
    if (at.length)
      add(
        'retry',
        `${count(at.length, 'failed call')} made again unchanged`,
        `The same call with the same input, right after it failed: ${tally(again)}. A retry unchanged rarely helps; what failed is worth teaching the agent, or fixing in the tool.`,
        tokens,
        at,
      );
  }

  // Interrupts: an interrupted tool call, or an interrupt with no tool call running.
  {
    const at: FindingRef[] = [];
    let turn = -1;
    let counted = false;
    for (const p of items) {
      if (p.turn !== turn) {
        turn = p.turn;
        counted = false;
      }
      if (p.it.type === 'model')
        for (const b of p.it.blocks)
          if (b.type === 'tool' && b.status === 'interrupted') {
            at.push(ref(p, `${toolLabel(b)} · interrupted`, b.id));
            counted = true;
          }
      if (p.it.type === 'notice' && p.it.interrupt) {
        if (!counted) at.push(ref(p, oneLine(p.it.text, 80)));
        counted = false;
      }
    }
    if (at.length)
      add(
        'interrupt',
        agent ? `The agent was interrupted ${times(at.length)}` : `You interrupted the agent ${times(at.length)}`,
        'Each interrupt stopped the agent doing something unwanted or slow; what it did just before is what to prevent.',
        null,
        at,
      );
  }

  // Errors from the model's API, or that the agent reported.
  {
    const at: FindingRef[] = [];
    for (const p of items) {
      if (p.it.type === 'model' && p.it.error) {
        const text = p.it.blocks.find((b) => b.type === 'text');
        at.push(ref(p, oneLine(text?.type === 'text' ? text.text : 'API error', 90)));
      } else if (p.it.type === 'notice' && p.it.level === 'error') at.push(ref(p, oneLine(p.it.text, 90)));
    }
    if (at.length)
      add(
        'api-error',
        `${count(at.length, 'error')} from the model’s API or the agent`,
        'Each one cost a retry or ended the turn; look for limits, overloads, or a request too large.',
        null,
        at,
      );
  }

  // Refusals.
  {
    const refused = tools.filter((p) => p.b.permission?.allowed === false);
    if (refused.length)
      add(
        'denied',
        `${count(refused.length, 'tool call')} refused`,
        `Refused by ${tally(refused.map((p) => (p.b.permission?.by === 'you' ? 'you' : (p.b.permission?.by ?? ''))))}: ${tally(refused.map((p) => p.b.name))}. A call the agent keeps asking for and is refused is worth a rule it knows of, or allowing.`,
        null,
        refused.map((p) =>
          toolRef(p, `${toolLabel(p.b)} · ${p.b.permission?.by === 'you' ? 'by you' : (p.b.permission?.by ?? '')}`),
        ),
      );
  }

  // Failed edits.
  {
    const failed = tools.filter((p) => p.b.file?.access === 'write' && p.b.status === 'error');
    if (failed.length) {
      const files = new Set(failed.map((p) => p.b.file?.path));
      add(
        'failed-edit',
        `${count(failed.length, 'file edit')} failed (${count(files.size, 'file')})`,
        `Most often: ${tally(
          failed.map((p) => `“${firstLine(p.b.output) || 'no message'}”`),
          2,
        )}. An edit that fails often follows a stale read, or text that is not unique in the file.`,
        null,
        failed.map((p) => toolRef(p, `${toolLabel(p.b)} · ${firstLine(p.b.output)}`)),
      );
    }
  }

  // The prompt cache rebuilt: a call that read from the cache much less than the call before it
  // held. After a pause, the cache had lapsed; without one, something changed the request's start.
  {
    const at: FindingRef[] = [];
    const lapsed: FindingRef[] = [];
    let tokens = 0;
    let lapsedTokens = 0;
    let previous: ModelItem | undefined;
    for (const p of items) {
      if (p.it.type === 'compaction') previous = undefined;
      if (p.it.type !== 'model' || p.it.context === null) continue;
      const m = p.it;
      const read = m.cacheRead ?? 0;
      if (previous?.context != null) {
        const lost = previous.context - read;
        const pause = m.start - previous.end;
        if (read < previous.context / 2 && lost >= CACHE_MISS_TOKENS) {
          // The cache is the model's: another model's call reads none of it.
          const switched =
            m.model !== null && previous.model !== null && m.model !== previous.model
              ? ` · ${m.model} after ${previous.model}`
              : '';
          const r = ref(p, `~${kTok(lost)} tokens written again · ${fmt(pause)} after the call before${switched}`);
          if (pause >= CACHE_PAUSE_MS) {
            lapsed.push(r);
            lapsedTokens += lost;
          } else {
            at.push(r);
            tokens += lost;
          }
        }
      }
      previous = m;
    }
    if (at.length)
      add(
        'cache-miss',
        `The prompt cache was rebuilt ${times(at.length)} without a pause`,
        'Something changed the start of the request (the system prompt, the tools, an earlier message) or the model, whose cache is its own, so the call wrote again what the call before it had cached. Each rebuild is slower and costs more than a read.',
        tokens,
        at,
      );
    if (lapsed.length)
      add(
        'cache-lapse',
        `The prompt cache lapsed ${times(lapsed.length)} after a pause`,
        `A call five minutes or more after the one before found the cache gone (it lasts five minutes by default) and wrote the whole context again: the longer the context, the more a pause costs.`,
        lapsedTokens,
        lapsed,
      );
  }

  // The system prompt or the tools changed between two calls.
  {
    const at: FindingRef[] = [];
    let shape: string | null = null;
    for (const p of models) {
      const s = p.it.request?.shape ?? null;
      if (s === null) continue;
      if (shape !== null && s !== shape) at.push(ref(p, shapeChange(shapes.get(shape), shapes.get(s))));
      shape = s;
    }
    if (at.length)
      add(
        'shape-change',
        `The system prompt or tools changed ${times(at.length)}`,
        'A change to them makes the next call write the whole request to the cache again; tools that come and go mid-thread, such as servers connecting late, cause it.',
        null,
        at,
      );
  }

  // A read made again with the same input, the file not written by the thread in between.
  {
    const last = new Map<string, string>(); // a path -> the input of its last read since it was last written
    const at: FindingRef[] = [];
    const paths: string[] = [];
    let tokens = 0;
    for (const p of tools) {
      const file = p.b.file;
      if (file === null || p.b.status !== 'ok') continue;
      if (file.access === 'write') {
        last.delete(file.path);
        continue;
      }
      if (last.get(file.path) === p.b.input) {
        at.push(toolRef(p, `${toolLabel(p.b)} · ~${kTok(p.b.tokens)}`));
        paths.push(p.b.detail || p.b.preview || file.path);
        tokens += p.b.tokens;
      }
      last.set(file.path, p.b.input);
    }
    if (at.length >= 2)
      add(
        'repeated-read',
        `${count(at.length, 'file read')} made again, the file unchanged`,
        `${tally(paths)}. What the agent read is still in its context, unless a compaction dropped it.`,
        tokens,
        at,
      );
  }

  // Large tool outputs.
  {
    const large = tools.filter((p) => p.b.tokens >= LARGE_OUTPUT_TOKENS);
    if (large.length) {
      const tokens = large.reduce((sum, p) => sum + p.b.tokens, 0);
      const top = large.reduce((x, y) => (y.b.tokens > x.b.tokens ? y : x));
      add(
        'large-output',
        `${count(large.length, 'tool output')} over ${kTok(LARGE_OUTPUT_TOKENS)} tokens`,
        `The largest: ${toolLabel(top.b)} (~${kTok(top.b.tokens)}). A tool that can return less (a limit, a filter, a summary) leaves the context for the work.`,
        tokens,
        large.map((p) => toolRef(p, `${toolLabel(p.b)} · ~${kTok(p.b.tokens)}`)),
      );
    }
  }

  // The same harness text, again and again while the model still had it: between two compactions,
  // since a compaction drops what came before it. The costliest texts are separate findings, since
  // each is its own thing to change; the rest are one.
  {
    const groups = new Map<string, Placed<ContextItem>[]>();
    let segment = 0;
    for (const p of items) {
      if (p.it.type === 'compaction') segment++;
      if (p.it.type !== 'context') continue;
      const k = `${segment}\n${p.it.label}\n${p.it.text}`;
      const it = { ...p, it: p.it };
      const g = groups.get(k);
      if (g) g.push(it);
      else groups.set(k, [it]);
    }
    // The same text in several segments is one text.
    const texts = new Map<string, { label: string; source: string; each: number; again: Placed<ContextItem>[] }>();
    for (const [first, ...again] of groups.values()) {
      if (first === undefined || !again.length) continue;
      const k = `${first.it.label}\n${first.it.text}`;
      const x = texts.get(k);
      if (x) x.again.push(...again);
      else texts.set(k, { label: first.it.label, source: first.it.source, each: first.it.tokens, again });
    }
    const costOf = (x: { readonly again: readonly Placed<ContextItem>[] }): number =>
      x.again.reduce((sum, p) => sum + p.it.tokens, 0);
    const repeated = [...texts.values()]
      .filter((x) => x.again.length >= 2 && (costOf(x) >= 500 || x.again.length >= 10))
      .sort((x, y) => costOf(y) - costOf(x));
    const placed = (list: readonly Placed<ContextItem>[]): FindingRef[] =>
      [...list]
        .sort((x, y) => x.turn - y.turn || x.item - y.item)
        .map((p) => ref(p, `${oneLine(p.it.label, 60)} · ~${kTok(p.it.tokens)}`));
    for (const x of repeated.slice(0, REPEATED_TEXTS))
      add(
        'repeated-context',
        `${oneLine(x.label, 60)} added again ${times(x.again.length)}, unchanged`,
        `The same ${x.source} text, ~${kTok(x.each)} tokens, while the model still had it in its context (no compaction in between); it costs its size each time.`,
        costOf(x),
        placed(x.again),
      );
    const rest = repeated.slice(REPEATED_TEXTS);
    if (rest.length)
      add(
        'repeated-context',
        `${count(rest.length, 'other harness text')} added again unchanged`,
        `${tally(
          rest.map((x) => oneLine(x.label, 40)),
          4,
        )}: each added again while the model still had it.`,
        rest.reduce((sum, x) => sum + costOf(x), 0),
        placed(rest.flatMap((x) => x.again)),
      );
  }

  // Compactions.
  {
    const done = items.flatMap((p) => (p.it.type === 'compaction' ? [{ ...p, it: p.it }] : []));
    if (done.length)
      add(
        'compaction',
        `The context was compacted ${times(done.length)}`,
        `A compaction replaces the conversation with a summary, and what the summary leaves out is gone${t.stats.peakContext === null ? '' : `; the context peaked at ${kTok(t.stats.peakContext)} tokens`}. What filled it is in the findings on large outputs and repeated text.`,
        null,
        done.map((p) =>
          ref(
            p,
            [
              p.it.trigger,
              p.it.preTokens === null
                ? null
                : `${kTok(p.it.preTokens)} → ${p.it.postTokens === null ? '?' : kTok(p.it.postTokens)} tokens`,
            ]
              .filter((x) => x !== null)
              .join(' · ') || 'compaction',
          ),
        ),
      );
  }

  // The context growing by much in one step, and what came in with it.
  {
    const at: FindingRef[] = [];
    let previous: number | null = null;
    // What came in since the call before: its tools' outputs, and the items after it.
    let since: { readonly label: string; readonly tokens: number }[] = [];
    for (const p of items) {
      const it = p.it;
      if (it.type === 'compaction') {
        previous = null;
        since = [];
      } else if (it.type === 'model') {
        if (it.context !== null) {
          const grew = previous === null ? 0 : it.context - previous;
          if (grew >= CONTEXT_JUMP_TOKENS) {
            const top = since.reduce<{ label: string; tokens: number } | null>(
              (x, y) => (x === null || y.tokens > x.tokens ? y : x),
              null,
            );
            at.push(ref(p, `+${kTok(grew)}${top === null ? '' : ` · mostly ${top.label} (~${kTok(top.tokens)})`}`));
          }
          previous = it.context;
          since = [];
        }
        for (const b of it.blocks) if (b.type === 'tool') since.push({ label: toolLabel(b), tokens: b.tokens });
      } else if (it.type === 'context') since.push({ label: it.label, tokens: it.tokens });
      else if (it.type === 'prompt') since.push({ label: 'the prompt', tokens: estimateTokens(it.text) });
      else if (it.type === 'result') since.push({ label: 'a result', tokens: estimateTokens(it.output) });
    }
    if (at.length)
      add(
        'context-jump',
        `${count(at.length, 'model call')} found the context over ${kTok(CONTEXT_JUMP_TOKENS)} tokens larger`,
        'What came in just before each one is what filled it.',
        null,
        at,
      );
  }

  // Heavy harness items.
  {
    const heavy = contexts.filter((p) => p.it.tokens >= HEAVY_CONTEXT_TOKENS);
    if (heavy.length) {
      const tokens = heavy.reduce((sum, p) => sum + p.it.tokens, 0);
      add(
        'heavy-context',
        `${count(heavy.length, 'harness item')} over ${kTok(HEAVY_CONTEXT_TOKENS)} tokens`,
        `${tally(heavy.map((p) => p.it.label))}. An instruction file, listing, or reminder this large costs its size in every thread that loads it.`,
        tokens,
        heavy.map((p) => ref(p, `${p.it.label} · ~${kTok(p.it.tokens)}`)),
      );
    }
  }

  // Tools the model was told of and never called.
  {
    const called = new Set(tools.map((p) => p.b.name));
    const defs = new Map<string, number>();
    for (const s of t.shapes)
      for (const d of shapes.get(s.id)?.tools ?? []) if (!d.deferred && !called.has(d.name)) defs.set(d.name, d.tokens);
    const tokens = [...defs.values()].reduce((sum, n) => sum + n, 0);
    if (defs.size && tokens >= UNUSED_TOOL_TOKENS) {
      const top = [...defs].sort((x, y) => y[1] - x[1]);
      add(
        'unused-tools',
        `${count(defs.size, 'tool')} never called`,
        `Sent with every request: ${top
          .slice(0, 6)
          .map(([name, n]) => `${name} (~${kTok(n)})`)
          .join(
            ', ',
          )}${top.length > 6 ? `, and ${top.length - 6} more` : ''}. A tool a thread like this never needs is context it pays for on each call.`,
        tokens,
        [],
      );
    }
  }

  // Slow tool calls: not an agent's, which run long by design, nor the person's answers.
  {
    const slow = tools.filter(
      (p) =>
        (p.b.ms ?? 0) >= SLOW_TOOL_MS &&
        !p.b.async &&
        p.b.category !== 'agent' &&
        p.b.category !== 'workflow' &&
        p.b.category !== 'question',
    );
    if (slow.length) {
      const top = slow.reduce((x, y) => ((y.b.ms ?? 0) > (x.b.ms ?? 0) ? y : x));
      add(
        'slow',
        `${count(slow.length, 'tool call')} took over ${fmt(SLOW_TOOL_MS)}`,
        `The slowest: ${toolLabel(top.b)} (${fmt(top.b.ms)}). A long command the agent waits on is worth a faster variant, or running in the background.`,
        null,
        slow.map((p) => toolRef(p, `${toolLabel(p.b)} · ${fmt(p.b.ms)}`)),
      );
    }
  }

  return out.sort(
    (x, y) =>
      SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity) ||
      (RANK.get(x.kind) ?? 0) - (RANK.get(y.kind) ?? 0),
  );
}
