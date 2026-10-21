import type {
  Compaction,
  LoadOptions,
  ResponseEvent,
  ToolCall,
  ToolResultEvent,
  TraceEvent,
  Usage,
} from '../../model/index.js';
import { isRecord, jsText, looseText, numberOr, stringOr } from '../../util/index.js';
import { describeTool } from './tools.js';

// Claude Code's transcript records as neutral events: the prototype's classify. Records are read
// as `unknown` and narrowed; a record of an unexpected shape reads as the prototype would read it
// where that does not throw.

/** What a transcript's records say, apart from their events. */
export interface Classified {
  /** The events, in file order. */
  readonly events: TraceEvent[];
  readonly cwd?: string;
  readonly title?: string;
  readonly compactions: Compaction[];
}

export const TOOL_USE_ID = /<tool-use-id>(.*?)<\/tool-use-id>/;
export const SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
export const COMMAND_NAME = /<command-name>(.*?)<\/command-name>/;

/** The text of a message's content: a string, or its text blocks joined by a space. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isRecord(block) && block['type'] === 'text' ? joinable(block['text']) : '')).join(' ');
}

/** A value as `Array.prototype.join` writes it: `null` and `undefined` are empty. */
const joinable = looseText;

/** The first record's working directory (the first that names one). */
export function cwdOf(records: readonly Record<string, unknown>[]): string | undefined {
  for (const r of records) {
    const cwd = r['cwd'];
    if (cwd) return typeof cwd === 'string' ? cwd : undefined;
  }
  return undefined;
}

function compactionOf(metadata: unknown): Compaction {
  const m = isRecord(metadata) ? metadata : {};
  const preTokens = numberOr(m['preTokens']);
  const postTokens = numberOr(m['postTokens']);
  const durationMs = numberOr(m['durationMs']);
  const trigger = stringOr(m['trigger']);
  return {
    ...(preTokens !== undefined && { preTokens }),
    ...(postTokens !== undefined && { postTokens }),
    ...(durationMs !== undefined && { durationMs }),
    ...(trigger !== undefined && { trigger }),
  };
}

/** A message's usage; undefined when it has none. */
export function usageOf(usage: unknown): Usage | undefined {
  if (usage == null) return undefined;
  const u = isRecord(usage) ? usage : {};
  return {
    output: numberOr(u['output_tokens']) ?? 0,
    cacheRead: numberOr(u['cache_read_input_tokens']) ?? 0,
    cacheWrite: numberOr(u['cache_creation_input_tokens']) ?? 0,
    input: numberOr(u['input_tokens']) ?? 0,
  };
}

/**
 * Whether any `user` record names its origin: in the older format none does, and plain text is
 * the person's prompt.
 */
export function hasOrigins(records: readonly Record<string, unknown>[]): boolean {
  return records.some((r) => r['type'] === 'user' && Boolean(r['origin']));
}

/** A `tool_use` block as a tool call, described for a transcript whose working directory is `cwd`. */
export function toolCallOf(block: Record<string, unknown>, cwd: string | undefined, options: LoadOptions): ToolCall {
  const name = stringOr(block['name']) ?? '';
  const input = isRecord(block['input']) ? block['input'] : {};
  return { id: stringOr(block['id']) ?? '', name, input, desc: describeTool(name, input, cwd, options) };
}

/** A message's id: the message's own, else the record's uuid. */
export function messageIdOf(r: Record<string, unknown>, m: Record<string, unknown>): string {
  return stringOr(m['id']) ?? stringOr(r['uuid']) ?? '';
}

function responseOf(
  r: Record<string, unknown>,
  ts: number,
  cwd: string | undefined,
  options: LoadOptions,
): ResponseEvent {
  const m = isRecord(r['message']) ? r['message'] : {};
  const rawContent = m['content'];
  const content: unknown[] = Array.isArray(rawContent) ? rawContent : [];
  const blocks = content.filter(isRecord);
  const model = stringOr(m['model']);
  const usage = usageOf(m['usage']);
  const toolCalls: ToolCall[] = blocks.filter((b) => b['type'] === 'tool_use').map((b) => toolCallOf(b, cwd, options));
  return {
    kind: 'response',
    ts,
    messageId: messageIdOf(r, m),
    ...(model !== undefined && { model }),
    synthetic: model === '<synthetic>',
    stop: stringOr(m['stop_reason']) ?? null,
    ...(usage !== undefined && { usage }),
    blocks: content.map((b) => (isRecord(b) ? (stringOr(b['type']) ?? '') : '')),
    text: blocks
      .filter((b) => b['type'] === 'text')
      .map((b) => joinable(b['text']))
      .join(' '),
    toolCalls,
  };
}

function toolResultOf(block: Record<string, unknown>, result: unknown, ts: number): ToolResultEvent {
  const res = isRecord(result) ? result : {};
  const content = block['content'];
  const agentId = stringOr(res['agentId']);
  const groupId = stringOr(res['runId']);
  return {
    kind: 'tool_result',
    ts,
    toolCallId: stringOr(block['tool_use_id']) ?? '',
    isError: block['is_error'] === true,
    interrupted: res['interrupted'] === true,
    output: Array.isArray(content)
      ? content
          .map((c) =>
            isRecord(c) && c['type'] === 'text'
              ? joinable(c['text'])
              : `[${jsText(isRecord(c) ? c['type'] : undefined)}]`,
          )
          .join('\n')
      : looseText(content),
    async: res['isAsync'] === true || res['status'] === 'async_launched' || res['backgroundTaskId'] != null,
    backgroundIds: [res['taskId'], res['backgroundTaskId'], res['agentId']].filter((id) => typeof id === 'string'),
    launches: { ...(agentId !== undefined && { agentId }), ...(groupId !== undefined && { groupId }) },
  };
}

/**
 * The events, working directory, title, and compactions of a transcript's records;
 * `options.subcommandTools` shape the shell keys of tool previews.
 */
export function classify(records: readonly unknown[], options: LoadOptions = {}): Classified {
  const recs = records.filter(isRecord);
  const hasOrigin = hasOrigins(recs);
  const cwd = cwdOf(recs);
  let title: string | undefined;
  const compactions: Compaction[] = [];
  const events: TraceEvent[] = [];
  for (const r of recs) {
    if (r['type'] === 'ai-title') title = stringOr(r['aiTitle']);
    if (r['type'] === 'system' && r['subtype'] === 'compact_boundary')
      compactions.push(compactionOf(r['compactMetadata']));
    const timestamp = r['timestamp'];
    if (!timestamp) continue;
    const ts = Date.parse(jsText(timestamp));

    // A background task's completion is queued as a notification, which may land mid-turn.
    const attachment = r['attachment'];
    const queued =
      r['type'] === 'queue-operation' && r['operation'] === 'enqueue'
        ? r['content']
        : isRecord(attachment) && attachment['type'] === 'queued_command'
          ? attachment['prompt']
          : undefined;
    const doneId = typeof queued === 'string' ? TOOL_USE_ID.exec(queued)?.[1] : undefined;
    if (doneId) {
      events.push({ kind: 'background_done', ts, toolCallId: doneId });
      continue;
    }
    if (r['type'] === 'assistant') {
      events.push(responseOf(r, ts, cwd, options));
      continue;
    }
    if (r['type'] !== 'user') continue;
    const message = r['message'];
    const content = isRecord(message) ? message['content'] : undefined;
    const results = Array.isArray(content)
      ? content.filter((b) => isRecord(b) && b['type'] === 'tool_result').filter(isRecord)
      : [];
    if (results.length) {
      for (const block of results) events.push(toolResultOf(block, r['toolUseResult'], ts));
      continue;
    }
    if (r['isMeta']) continue;
    const text = textOf(content);
    const origin = r['origin'];
    const originKind = isRecord(origin) ? origin['kind'] : undefined;
    if (r['isCompactSummary']) events.push({ kind: 'compaction_done', ts });
    else if (text.startsWith('[Request interrupted')) events.push({ kind: 'interrupt', ts });
    else if (originKind === 'human') events.push({ kind: 'prompt', ts, text });
    else if (originKind === 'task-notification' || text.startsWith('<task-notification>')) {
      const toolCallId = TOOL_USE_ID.exec(text)?.[1];
      events.push({
        kind: 'notification',
        ts,
        text: SUMMARY.exec(text)?.[1] ?? text,
        ...(toolCallId !== undefined && { toolCallId }),
      });
    } else if (origin) events.push({ kind: 'prompt', ts, text: `[${jsText(originKind)}] ${text}` });
    else if (text.startsWith('<command-name>')) {
      const name = COMMAND_NAME.exec(text)?.[1] ?? text;
      events.push({ kind: 'command', ts, name, compaction: name === '/compact' });
    } else if (text.startsWith('<'))
      continue; // command output, caveats, and other wrappers
    else if (!hasOrigin) events.push({ kind: 'prompt', ts, text });
  }
  return {
    events,
    compactions,
    ...(cwd !== undefined && { cwd }),
    ...(title !== undefined && { title }),
  };
}
