import { relative } from 'node:path';

import type {
  ContextSource,
  ConversationEntry,
  LoadOptions,
  Permission,
  RequestInfo,
  RequestShape,
  ResponseBlock,
  ResponseEntry,
  ResultEntry,
  ToolDefinition,
} from '../../model/index.js';
import { isRecord, jsText, looseText, numberOr, stringOr } from '../../util/index.js';
import { COMMAND_NAME, hasOrigins, messageIdOf, SUMMARY, textOf, toolCallOf, usageOf } from './classify.js';

// Claude Code's transcript records as a conversation: everything the model saw and said, in file
// order. It reads the records apart from classify, so the events stay the prototype's; where a
// user record starts a turn, it decides as classify does, so that the conversation's prompts are
// the events' prompts, notifications, and commands, one for one.

const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const REMINDER = /^\s*<system-reminder>/;
const LEADING_TAG = /^\s*<([\w-]+)/;

/** What each attachment type is, and how it is named; any other type is named after itself. */
const ATTACHMENTS: Readonly<Record<string, readonly [ContextSource, string]>> = {
  instructions: ['instructions', 'Instructions'],
  nested_memory: ['memory', 'Memory'],
  skill_listing: ['skill', 'Skill listing'],
  invoked_skills: ['skill', 'Invoked skills'],
  skill_mention: ['skill', 'Skill mention'],
  deferred_tools_delta: ['tools', 'Deferred tools'],
  deferred_tools_record: ['tools', 'Deferred tools'],
  mcp_instructions_delta: ['tools', 'MCP instructions'],
  agent_listing_delta: ['tools', 'Agent listing'],
  command_permissions: ['tools', 'Command permissions'],
  date: ['environment', 'Date'],
  environment: ['environment', 'Environment'],
  model: ['environment', 'Model'],
  output_style: ['environment', 'Output style'],
  output_style_instructions: ['environment', 'Output style instructions'],
  session_context: ['environment', 'Session context'],
  auto_mode: ['environment', 'Auto mode'],
  plan_mode: ['environment', 'Plan mode'],
  remote_session_change: ['environment', 'Remote session'],
  file: ['file', 'File'],
  directory: ['file', 'Directory'],
  edited_text_file: ['file', 'Edited file'],
  compact_file_reference: ['file', 'File reference'],
  at_mention_reference: ['file', 'Mention'],
  read_truncation_notice: ['reminder', 'Read truncated'],
  total_tokens_reminder: ['reminder', 'Token budget'],
  silent_turn_reminder: ['reminder', 'Silent turn'],
  task_reminder: ['reminder', 'Task reminder'],
  todo_reminder: ['reminder', 'To-do reminder'],
  hook_additional_context: ['hook', 'Hook'],
  task_status: ['task', 'Task status'],
  queued_command: ['message', 'Queued message'],
};

/** A record type or subtype as words: `turn_duration` reads `Turn duration`. */
function humanize(type: string): string {
  const words = type.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A path as the conversation names it: relative to the working directory when inside it. */
function shortPath(path: string, cwd: string | undefined): string {
  return cwd && path.startsWith(cwd + '/') ? relative(cwd, path) : path;
}

/** What an attachment is, and its label: its kind, with the file, hook, or count it is about. */
function attachmentOf(
  type: string,
  a: Record<string, unknown>,
  text: string,
  cwd: string | undefined,
): [ContextSource, string] {
  if (type === 'queued_command' && text.includes('<task-notification>')) return ['task', 'Task notification'];
  const known = Object.hasOwn(ATTACHMENTS, type) ? ATTACHMENTS[type] : undefined;
  const source: ContextSource =
    known?.[0] ?? (type.includes('hook') ? 'hook' : type.includes('reminder') ? 'reminder' : 'message');
  const name = known?.[1] ?? humanize(type);
  const files = a['files'];
  const paths = Array.isArray(files)
    ? files.flatMap((f) => (isRecord(f) && typeof f['path'] === 'string' ? [shortPath(f['path'], cwd)] : []))
    : [];
  const path = stringOr(a['displayPath']) ?? stringOr(a['filename']) ?? stringOr(a['path']);
  const hook = stringOr(a['hookName']);
  const event = stringOr(a['hookEvent']);
  const count = numberOr(a['skillCount']);
  const detail = paths.length
    ? paths.join(', ')
    : path !== undefined
      ? shortPath(path, cwd)
      : hook !== undefined
        ? `${hook}${event === undefined ? '' : ` (${event})`}`
        : count !== undefined
          ? `${count} skills`
          : '';
  return [source, detail ? `${name} · ${detail}` : name];
}

/** What a user message that wraps its text in a tag is, by its first tag. */
function wrapperOf(text: string): [ContextSource, string] {
  if (REMINDER.test(text)) return ['reminder', 'System reminder'];
  const tag = LEADING_TAG.exec(text)?.[1];
  switch (tag) {
    case 'command-message':
    case 'command-name': {
      const name = COMMAND_NAME.exec(text)?.[1];
      return ['command', name === undefined ? 'Command' : `Command · ${name}`];
    }
    case 'local-command-stdout':
    case 'local-command-stderr':
      return ['command', 'Command output'];
    case 'local-command-caveat':
      return ['command', 'Command caveat'];
    case 'bash-input':
    case 'bash-stdout':
    case 'bash-stderr':
      return ['command', 'Your shell command'];
    case 'task-notification':
      return ['task', 'Task notification'];
    case undefined:
      if (text.startsWith('Base directory for this skill')) return ['skill', 'Skill'];
      if (text.startsWith('[Image')) return ['file', 'Image'];
      return ['message', 'Message'];
    default:
      return ['message', humanize(tag)];
  }
}

/** A user message's content: its texts in order, and how many images it holds. */
function partsOf(content: unknown): { readonly texts: string[]; readonly images: number } {
  if (typeof content === 'string') return { texts: [content], images: 0 };
  if (!Array.isArray(content)) return { texts: [], images: 0 };
  const blocks = content.filter(isRecord);
  return {
    texts: blocks.flatMap((b) => (b['type'] === 'text' ? [looseText(b['text'])] : [])),
    images: blocks.filter((b) => b['type'] === 'image').length,
  };
}

/** How the model was asked to reason: the request's thinking type, with its budget when it set one. */
function thinkingOf(thinking: unknown): string | undefined {
  if (!isRecord(thinking)) return undefined;
  const type = stringOr(thinking['type']);
  const budget = numberOr(thinking['budget_tokens']);
  return type === undefined ? undefined : budget === undefined ? type : `${type}, ${budget} tokens`;
}

/** The `api-request` records' settings, by the request's id, which an assistant record's `requestRef` names. */
function requestsOf(records: readonly Record<string, unknown>[]): Map<string, RequestInfo> {
  const requests = new Map<string, RequestInfo>();
  for (const r of records) {
    if (r['type'] !== 'api-request') continue;
    const id = stringOr(r['id']);
    if (id === undefined) continue;
    const params = isRecord(r['params']) ? r['params'] : {};
    const output = isRecord(params['output_config']) ? params['output_config'] : {};
    const shape = stringOr(r['shapeHash']);
    const model = stringOr(params['model']);
    const effort = stringOr(output['effort']);
    const maxTokens = numberOr(params['max_tokens']);
    const thinking = thinkingOf(params['thinking']);
    requests.set(id, {
      ...(shape !== undefined && { shape }),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      ...(maxTokens !== undefined && { maxTokens }),
      ...(thinking !== undefined && { thinking }),
    });
  }
  return requests;
}

/**
 * The system prompts and tools a transcript's model calls were sent with: its `api-request-shape`
 * records, one per shape, in file order.
 */
export function requestShapesOf(records: readonly unknown[]): RequestShape[] {
  const shapes = new Map<string, RequestShape>();
  for (const r of records) {
    if (!isRecord(r) || r['type'] !== 'api-request-shape') continue;
    const id = stringOr(r['shapeHash']);
    const shape = isRecord(r['shape']) ? r['shape'] : {};
    if (id === undefined || shapes.has(id)) continue;
    const system = Array.isArray(shape['system']) ? shape['system'] : [];
    const tools = Array.isArray(shape['tools']) ? shape['tools'] : [];
    shapes.set(id, {
      id,
      ts: Date.parse(jsText(r['timestamp'])),
      system: system.flatMap((b) => (isRecord(b) && typeof b['text'] === 'string' ? [b['text']] : [])),
      tools: tools.filter(isRecord).map((t): ToolDefinition => ({
        name: stringOr(t['name']) ?? '',
        description: stringOr(t['description']) ?? '',
        schema: JSON.stringify(t['input_schema'] ?? {}, null, 2),
        deferred: t['defer_loading'] === true,
      })),
    });
  }
  return [...shapes.values()];
}

function responseOf(
  r: Record<string, unknown>,
  ts: number,
  cwd: string | undefined,
  options: LoadOptions,
  requests: ReadonlyMap<string, RequestInfo>,
): ResponseEntry {
  const m = isRecord(r['message']) ? r['message'] : {};
  const content = m['content'];
  const thinkingMs = numberOr(r['thinkingDurationMs']);
  const blocks: ResponseBlock[] = (Array.isArray(content) ? content : []).filter(isRecord).map((b): ResponseBlock => {
    const type = stringOr(b['type']) ?? '';
    switch (type) {
      case 'thinking':
        return {
          type: 'thinking',
          text: stringOr(b['thinking']) ?? '',
          redacted: false,
          ...(thinkingMs !== undefined && { ms: thinkingMs }),
        };
      case 'redacted_thinking':
        return { type: 'thinking', text: '', redacted: true, ...(thinkingMs !== undefined && { ms: thinkingMs }) };
      case 'text':
        return { type: 'text', text: looseText(b['text']) };
      case 'tool_use':
        return { type: 'tool', call: toolCallOf(b, cwd, options) };
      default: {
        const { type: _type, ...rest } = b;
        return { type: 'other', label: type, text: JSON.stringify(rest, null, 2) };
      }
    }
  });
  const model = stringOr(m['model']);
  const usage = usageOf(m['usage']);
  const ref = stringOr(r['requestRef']);
  const request = ref === undefined ? undefined : requests.get(ref);
  return {
    kind: 'response',
    ts,
    messageId: messageIdOf(r, m),
    ...(model !== undefined && { model }),
    synthetic: model === '<synthetic>',
    error: r['isApiErrorMessage'] === true,
    stop: stringOr(m['stop_reason']) ?? null,
    ...(usage !== undefined && { usage }),
    ...(request !== undefined && { request }),
    blocks,
  };
}

/** Who let a call run or refused it: the record's permission decision, else why it was denied. */
function permissionOf(r: Record<string, unknown>): Permission | undefined {
  const decision = r['permissionDecision'];
  if (isRecord(decision)) {
    const source = stringOr(decision['source']) ?? '';
    const reason = stringOr(decision['reasonType']);
    return {
      allowed: decision['decision'] === 'accept',
      by: source.startsWith('user') ? 'you' : reason !== undefined && reason !== '' ? reason : source,
    };
  }
  const denial = stringOr(r['toolDenialKind']);
  if (denial === undefined || denial === 'interrupted') return undefined;
  return { allowed: false, by: denial === 'user-rejected' ? 'you' : denial };
}

function resultOf(block: Record<string, unknown>, r: Record<string, unknown>, ts: number): ResultEntry {
  const res = isRecord(r['toolUseResult']) ? r['toolUseResult'] : {};
  const content = block['content'];
  const parts = Array.isArray(content) ? content : [];
  const permission = permissionOf(r);
  return {
    kind: 'result',
    ts,
    toolCallId: stringOr(block['tool_use_id']) ?? '',
    isError: block['is_error'] === true,
    interrupted: res['interrupted'] === true,
    output: Array.isArray(content)
      ? parts
          .map((c) =>
            isRecord(c) && c['type'] === 'text'
              ? looseText(c['text'])
              : `[${jsText(isRecord(c) ? c['type'] : undefined)}]`,
          )
          .join('\n')
      : looseText(content),
    images: parts.filter((c) => isRecord(c) && c['type'] === 'image').length,
    ...(permission !== undefined && { permission }),
  };
}

/** A notice's level from a system record's: `error`, `warning`, else `info`. */
function levelOf(level: unknown): 'info' | 'warning' | 'error' {
  return level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info';
}

/**
 * The conversation of a transcript's records, in file order, for a transcript whose working
 * directory is `cwd`; `options.subcommandTools` shape the shell keys of tool previews.
 */
export function conversationOf(
  records: readonly unknown[],
  cwd: string | undefined,
  options: LoadOptions = {},
): ConversationEntry[] {
  const recs = records.filter(isRecord);
  const hasOrigin = hasOrigins(recs);
  const requests = requestsOf(recs);
  const entries: ConversationEntry[] = [];
  // The compaction whose summary has not landed yet, by its index in entries.
  let pending: number | undefined;
  const context = (ts: number, text: string, [source, label]: [ContextSource, string]): void => {
    if (text.trim()) entries.push({ kind: 'context', ts, source, label, text });
  };
  for (const r of recs) {
    const timestamp = r['timestamp'];
    if (!timestamp) continue;
    const ts = Date.parse(jsText(timestamp));
    const type = r['type'];

    if (type === 'assistant') {
      entries.push(responseOf(r, ts, cwd, options, requests));
      continue;
    }
    if (type === 'attachment') {
      // An attachment without a rendering was not shown to the model, such as the agent's own bookkeeping.
      const a = isRecord(r['attachment']) ? r['attachment'] : {};
      const rendered = r['rendered'];
      const text = (Array.isArray(rendered) ? rendered : [])
        .flatMap((part) => (isRecord(part) && typeof part['content'] === 'string' ? [part['content']] : []))
        .join('\n\n');
      context(ts, text, attachmentOf(stringOr(a['type']) ?? '', a, text, cwd));
      continue;
    }
    if (type === 'system') {
      const subtype = stringOr(r['subtype']) ?? '';
      const content = stringOr(r['content']) ?? '';
      if (subtype === 'compact_boundary') {
        const m = isRecord(r['compactMetadata']) ? r['compactMetadata'] : {};
        const trigger = stringOr(m['trigger']);
        const preTokens = numberOr(m['preTokens']);
        const postTokens = numberOr(m['postTokens']);
        pending = entries.length;
        entries.push({
          kind: 'compaction',
          ts,
          ...(trigger !== undefined && { trigger }),
          ...(preTokens !== undefined && { preTokens }),
          ...(postTokens !== undefined && { postTokens }),
          summary: '',
        });
      } else if (subtype === 'local_command')
        context(ts, content.replace(/<\/?local-command-std(out|err)>/g, '').trim(), ['command', 'Command output']);
      // How long a turn took, and the recap shown to a person who was away, are for the person only.
      else if (subtype !== 'turn_duration' && subtype !== 'away_summary')
        entries.push({ kind: 'notice', ts, level: levelOf(r['level']), text: content || humanize(subtype) });
      continue;
    }
    if (type !== 'user') continue;

    const message = r['message'];
    const content = isRecord(message) ? message['content'] : undefined;
    const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
    const results = blocks.filter((b) => b['type'] === 'tool_result');
    if (results.length) {
      for (const block of results) entries.push(resultOf(block, r, ts));
      for (const b of blocks)
        if (b['type'] === 'text') context(ts, looseText(b['text']), wrapperOf(looseText(b['text'])));
      continue;
    }
    const text = textOf(content);
    if (r['isMeta']) {
      context(ts, text, wrapperOf(text));
      continue;
    }
    const origin = r['origin'];
    const originKind = isRecord(origin) ? origin['kind'] : undefined;
    const parts = partsOf(content);
    // The prompt's own text, without the reminders the harness added to it, which follow it.
    const prompt = (by: 'you' | 'task' | 'command', promptText: string, from?: string): void => {
      const summary = by === 'task' ? SUMMARY.exec(promptText)?.[1]?.trim() : undefined;
      entries.push({
        kind: 'prompt',
        ts,
        by,
        text: promptText,
        ...(from !== undefined && { origin: from }),
        ...(summary !== undefined && summary !== '' && { summary }),
        images: parts.images,
      });
      for (const t of parts.texts) if (REMINDER.test(t)) context(ts, t, wrapperOf(t));
    };
    const own = parts.texts.filter((t) => !REMINDER.test(t)).join('\n\n');

    if (r['isCompactSummary']) {
      const at = pending === undefined ? undefined : entries[pending];
      if (pending !== undefined && at?.kind === 'compaction') entries[pending] = { ...at, summary: text };
      else entries.push({ kind: 'compaction', ts, summary: text });
      pending = undefined;
    } else if (text.startsWith('[Request interrupted'))
      entries.push({ kind: 'notice', ts, level: 'warning', text: text.replace(/^\[|\]$/g, ''), interrupt: true });
    else if (originKind === 'human') prompt('you', own);
    else if (originKind === 'task-notification' || text.startsWith('<task-notification>')) prompt('task', own);
    else if (origin) prompt('you', own, jsText(originKind));
    else if (text.startsWith('<command-name>')) {
      const name = COMMAND_NAME.exec(text)?.[1] ?? text;
      const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
      prompt('command', args ? `${name} ${args}` : name);
    } else if (text.startsWith('<')) context(ts, text, wrapperOf(text));
    else if (!hasOrigin) prompt('you', own);
    else context(ts, text, ['message', 'Message']);
  }
  return entries;
}
