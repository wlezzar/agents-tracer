import {
  activeOf,
  analyzeSession,
  MAIN,
  sumTools,
  usageKnown,
  usageTotals,
  wallOf,
  youOf,
  type SessionAnalysis,
  type TranscriptAnalysis,
} from '../analysis/index.js';
import type {
  ConversationEntry,
  ResponseBlock,
  ResponseEntry,
  ResponseEvent,
  ResultEntry,
  Session,
  ToolCall,
  Transcript,
  TraceEvent,
} from '../model/index.js';
import type {
  Conversation,
  ConversationBlock,
  ConversationItem,
  ConversationTurn,
  ModelItem,
  Thread,
  ThreadStats,
  ToolBlock,
  ToolStatus,
} from './types.js';

// A session's conversation from its analysis: each transcript's conversation entries in file
// order, cut into the analysis's turns, with each model call's records merged, each tool call's
// result beside it, and the timing and token counts the analysis has for them.

/**
 * A text's size in tokens, estimated at four characters a token: enough to compare what fills the
 * context, not to count it. A model call's context is the count the agent recorded.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A tool call's preview without the purpose it may start with (whole, or cut short with an
 * ellipsis, before a ` · `), which is shown beside it.
 */
export function previewBeside(preview: string, purpose: string): string {
  const at = preview.indexOf(' · ');
  if (!purpose || at < 0) return preview === purpose ? '' : preview;
  const head = preview.slice(0, at).replace(/…$/, '');
  return head && purpose.replace(/\s+/g, ' ').startsWith(head) ? preview.slice(at + 3) : preview;
}

/** A response record's blocks as its events say them, for an adapter that reads no conversation. */
function blocksOf(e: ResponseEvent): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];
  let calls = 0;
  let text = false;
  for (const b of e.blocks) {
    if (b === 'thinking' || b === 'redacted_thinking')
      blocks.push({ type: 'thinking', text: '', redacted: b === 'redacted_thinking' });
    else if (b === 'text' && !text && e.text) {
      text = true;
      blocks.push({ type: 'text', text: e.text });
    } else if (b === 'tool_use') {
      const call = e.toolCalls[calls];
      if (call) blocks.push({ type: 'tool', call });
      calls++;
    }
  }
  for (const call of e.toolCalls.slice(calls)) blocks.push({ type: 'tool', call });
  if (!text && e.text) blocks.push({ type: 'text', text: e.text });
  return blocks;
}

/** What a transcript's events say, as conversation entries, for an adapter that reads no conversation. */
function fromEvents(events: readonly TraceEvent[]): ConversationEntry[] {
  return events.flatMap((e): ConversationEntry[] => {
    switch (e.kind) {
      case 'prompt':
        return [{ kind: 'prompt', ts: e.ts, by: 'you', text: e.text, images: 0 }];
      case 'notification':
        return [{ kind: 'prompt', ts: e.ts, by: 'task', text: e.text, images: 0 }];
      case 'command':
        return [{ kind: 'prompt', ts: e.ts, by: 'command', text: e.name, images: 0 }];
      case 'response':
        return [
          {
            kind: 'response',
            ts: e.ts,
            messageId: e.messageId,
            ...(e.model !== undefined && { model: e.model }),
            synthetic: e.synthetic,
            error: false,
            stop: e.stop,
            ...(e.usage !== undefined && { usage: e.usage }),
            blocks: blocksOf(e),
          },
        ];
      case 'tool_result':
        return [
          {
            kind: 'result',
            ts: e.ts,
            toolCallId: e.toolCallId,
            isError: e.isError,
            interrupted: e.interrupted,
            output: e.output,
            images: 0,
          },
        ];
      case 'compaction_done':
        return [{ kind: 'compaction', ts: e.ts, summary: '' }];
      case 'interrupt':
        return [{ kind: 'notice', ts: e.ts, level: 'warning', text: 'Interrupted' }];
      case 'background_done':
        return [];
    }
  });
}

/** A transcript's conversation entries: what its adapter read, else what its events say. */
export function entriesOf(transcript: Transcript): readonly ConversationEntry[] {
  return transcript.conversation ?? fromEvents(transcript.events);
}

/** What sets a thread apart: the main transcript's, or an agent's and where it was launched. */
interface ThreadInfo {
  readonly label: string;
  readonly parent: string | null;
  readonly launcher: string | null;
  readonly agentType: string | null;
  readonly phase: string | null;
  readonly background: boolean;
}

/** A turn being filled. */
interface Draft {
  readonly n: number;
  readonly kind: ConversationTurn['kind'];
  readonly ts: number;
  readonly items: ConversationItem[];
}

function thread(id: string, a: TranscriptAnalysis, info: ThreadInfo, agents: ReadonlySet<string>): Thread {
  const entries = entriesOf(a.transcript);
  const known = usageKnown(a.calls);
  const calls = new Map(a.calls.map((c) => [c.messageId, c]));
  const runs = new Map(a.tools.map((t) => [t.id, t]));
  const results = new Map<string, ResultEntry>(); // a tool call's id -> its last result
  const records = new Map<string, ResponseEntry[]>(); // a message's id -> its records
  const asked = new Set<string>(); // the ids of the tool calls the thread's responses ask for
  for (const e of entries) {
    if (e.kind === 'result') results.set(e.toolCallId, e);
    if (e.kind !== 'response') continue;
    const list = records.get(e.messageId);
    if (list) list.push(e);
    else records.set(e.messageId, [e]);
    for (const b of e.blocks) if (b.type === 'tool') asked.add(b.call.id);
  }

  const toolBlock = (call: ToolCall, ts: number): ToolBlock => {
    const run = runs.get(call.id);
    const result = results.get(call.id);
    const output = result?.output ?? run?.output ?? '';
    const answered = run === undefined ? result !== undefined : run.end !== undefined;
    const status: ToolStatus = !answered
      ? 'pending'
      : (run?.interrupted ?? result?.interrupted)
        ? 'interrupted'
        : (run?.isError ?? result?.isError)
          ? 'error'
          : 'ok';
    const agent = run?.launches.agentId;
    return {
      type: 'tool',
      id: call.id,
      name: call.name,
      category: call.desc.category,
      preview: call.desc.preview,
      purpose: call.desc.purpose ?? '',
      detail: previewBeside(call.desc.preview, call.desc.purpose ?? ''),
      input: call.desc.inputText,
      output,
      status,
      async: run?.async ?? false,
      start: run?.start ?? ts,
      end: run?.end ?? result?.ts ?? null,
      ms: run?.ms ?? null,
      images: result?.images ?? 0,
      tokens: estimateTokens(output),
      permission: result?.permission ?? null,
      agent: agent !== undefined && agents.has(agent) ? agent : null,
    };
  };

  const modelItem = (list: readonly ResponseEntry[]): ModelItem | undefined => {
    const [first] = list;
    if (first === undefined) return undefined;
    const call = calls.get(first.messageId);
    const synthetic = call?.synthetic ?? first.synthetic;
    // A response the agent wrote itself read no context, whatever usage it carries.
    const usage = synthetic ? undefined : (call?.usage ?? list.findLast((e) => e.usage !== undefined)?.usage);
    const blocks = list.flatMap((e) =>
      e.blocks.map((b): ConversationBlock => {
        switch (b.type) {
          case 'thinking':
            return { type: 'thinking', text: b.text, redacted: b.redacted, ms: b.ms ?? null };
          case 'tool':
            return toolBlock(b.call, e.ts);
          case 'text':
          case 'other':
            return b;
        }
      }),
    );
    return {
      type: 'model',
      id: first.messageId,
      ts: first.ts,
      start: call?.start ?? first.ts,
      end: call?.end ?? list[list.length - 1]?.ts ?? first.ts,
      ms: call?.ms ?? 0,
      model: call?.model ?? first.model ?? null,
      synthetic,
      error: list.some((e) => e.error),
      stop: call?.stop ?? list[list.length - 1]?.stop ?? null,
      context: usage === undefined ? null : usage.input + usage.cacheRead + usage.cacheWrite,
      out: usage === undefined || !known ? null : usage.output,
      blocks,
    };
  };

  const drafts: Draft[] = [];
  let current: Draft | undefined;
  const add = (item: ConversationItem): void => {
    if (current === undefined) {
      current = { n: 0, kind: null, ts: item.ts, items: [] };
      drafts.push(current);
    }
    current.items.push(item);
  };
  const merged = new Set<string>();
  let n = 0;
  for (const e of entries) {
    switch (e.kind) {
      case 'prompt':
        current = { n: ++n, kind: e.by, ts: e.ts, items: [] };
        drafts.push(current);
        add({
          type: 'prompt',
          ts: e.ts,
          by: e.by,
          text: e.text,
          origin: e.origin ?? null,
          summary: e.summary ?? null,
          images: e.images,
        });
        break;
      case 'response': {
        if (merged.has(e.messageId)) break;
        merged.add(e.messageId);
        const item = modelItem(records.get(e.messageId) ?? [e]);
        if (item) add(item);
        break;
      }
      case 'result':
        if (!asked.has(e.toolCallId))
          add({
            type: 'result',
            ts: e.ts,
            id: e.toolCallId,
            output: e.output,
            status: e.interrupted ? 'interrupted' : e.isError ? 'error' : 'ok',
          });
        break;
      case 'context':
        add({
          type: 'context',
          ts: e.ts,
          source: e.source,
          label: e.label,
          text: e.text,
          tokens: estimateTokens(e.text),
        });
        break;
      case 'compaction':
        add({
          type: 'compaction',
          ts: e.ts,
          trigger: e.trigger ?? null,
          preTokens: e.preTokens ?? null,
          postTokens: e.postTokens ?? null,
          summary: e.summary,
        });
        break;
      case 'notice':
        add({ type: 'notice', ts: e.ts, level: e.level, text: e.text });
        break;
    }
  }

  const turns = drafts.map((d): ConversationTurn => {
    // The analysis's turn of the same number, when it was started the same way; the adapter makes
    // one prompt entry per turn-starting event, so they agree unless its records are out of order.
    const t = d.n > 0 ? a.turns[d.n - 1] : undefined;
    const turn = t?.kind === d.kind ? t : undefined;
    const last = d.items.reduce((at, i) => Math.max(at, i.type === 'model' ? i.end : i.ts), d.ts);
    return {
      n: d.n,
      kind: d.kind,
      ts: d.ts,
      end: turn?.end ?? last,
      active: turn ? activeOf(turn.buckets) : 0,
      items: d.items,
    };
  });

  const items = turns.flatMap((t) => t.items);
  const tools = items.flatMap((i) => (i.type === 'model' ? i.blocks : [])).filter((b) => b.type === 'tool');
  const contexts = items.filter((i) => i.type === 'context');
  const sizes = items.flatMap((i) => (i.type === 'model' && i.context !== null ? [i.context] : []));
  const u = usageTotals(a.calls);
  const wall = wallOf(a);
  const stats: ThreadStats = {
    wall: Number.isFinite(wall) ? wall : null,
    active: activeOf(a.buckets),
    model: a.buckets.get('model') ?? 0,
    tools: sumTools(a.buckets),
    you: youOf(a.buckets),
    calls: a.calls.length,
    toolCalls: a.tools.length,
    failed: tools.filter((b) => b.status === 'error' || b.status === 'interrupted').length,
    denied: tools.filter((b) => b.permission?.allowed === false).length,
    out: known ? u.output : null,
    peakContext: sizes.length ? sizes.reduce((x, y) => Math.max(x, y)) : null,
    contextItems: contexts.length,
    contextTokens: contexts.reduce((sum, c) => sum + c.tokens, 0),
    compactions: items.filter((i) => i.type === 'compaction').length,
  };
  return {
    id,
    ...info,
    start: a.start ?? null,
    end: a.end ?? null,
    usageKnown: known,
    stats,
    turns,
  };
}

/** The conversation of an analyzed session: the main transcript's thread, then each agent's by start. */
export function buildConversation(analysis: SessionAnalysis): Conversation {
  const { session, main, agents } = analysis;
  const ids = new Set(agents.map((x) => x.agent.id));
  // An agent's id -> the thread and the tool call that launched it; a later thread's wins, as the
  // analysis's parent does.
  const launchers = new Map<string, { thread: string; call: string }>();
  for (const [thread, a] of [[MAIN, main] as const, ...agents.map((x) => [x.agent.id, x.analysis] as const)])
    for (const run of a.tools) if (run.launches.agentId) launchers.set(run.launches.agentId, { thread, call: run.id });

  const startOf = (a: TranscriptAnalysis): number => a.start ?? NaN;
  const threads: Thread[] = [
    thread(
      MAIN,
      main,
      { label: 'Main session', parent: null, launcher: null, agentType: null, phase: null, background: false },
      ids,
    ),
    ...[...agents]
      .sort((x, y) => startOf(x.analysis) - startOf(y.analysis))
      .map(({ agent, analysis: a, parent }) => {
        const launcher = launchers.get(agent.id);
        return thread(
          agent.id,
          a,
          {
            label: agent.description ?? agent.id,
            parent,
            launcher: launcher?.thread === parent ? launcher.call : null,
            agentType: agent.agentType ?? null,
            phase: agent.phase ?? null,
            background: agent.background,
          },
          ids,
        );
      }),
  ];
  return {
    session: {
      id: main.transcript.id,
      title: main.transcript.title ?? null,
      cwd: main.transcript.cwd ?? null,
      file: main.transcript.path,
    },
    shellLabel: session.shellToolName ?? 'Shell',
    threads,
  };
}

/** The conversation of a session, analyzed first. */
export function sessionConversation(session: Session): Conversation {
  return buildConversation(analyzeSession(session));
}
