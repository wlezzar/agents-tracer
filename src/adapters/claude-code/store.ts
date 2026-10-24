import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import type {
  LoadOptions,
  ResolveOptions,
  SessionSummary,
  StoredSession,
  StoreSummary,
  Transcript,
} from '../../model/index.js';
import { isRecord, jsText, numberOr, parseJsonLines, stringOr } from '../../util/index.js';
import { classify, textOf } from './classify.js';
import { conversationOf, requestShapesOf } from './conversation.js';

// Where Claude Code keeps a project's transcripts, and how they are found: the prototype's
// readJsonl, listSessions, resolve, findSubagents, and workflowSummary.
//
//   ~/.claude/projects/                                                   the root of every project's store
//   ~/.claude/projects/<project>/<session>.jsonl                          a session
//   <project>/<session>/subagents/**/agent-<agentId>.jsonl                its subagents
//   <project>/<session>/subagents/**/agent-<agentId>.meta.json            what each was asked
//   <project>/<session>/subagents/workflows/<runId>/agent-<agentId>.jsonl a workflow run's agents
//   <project>/<session>/workflows/<runId>.json                            the run's summary

const EXT = '.jsonl';

/** The directory of every project's store. */
export function defaultRoot(home: string): string {
  return join(home, '.claude', 'projects');
}

/** The store of the project in `cwd`: every character outside [a-zA-Z0-9] of it becomes `-`. */
export function defaultStore(cwd: string, home: string): string {
  return join(defaultRoot(home), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** The records of a transcript file, as `unknown`; a partial last line is skipped. */
export function readRecords(file: string): unknown[] {
  return parseJsonLines(readFileSync(file, 'utf8'));
}

/** A transcript file read into the neutral model, with its conversation when `options.conversation` asks for it. */
export function readTranscript(file: string, options: LoadOptions = {}): Transcript {
  const records = readRecords(file);
  const { events, compactions, cwd, title } = classify(records, options);
  return {
    id: basename(file, EXT),
    path: file,
    events,
    compactions,
    ...(cwd !== undefined && { cwd }),
    ...(title !== undefined && { title }),
    ...(options.conversation === true && {
      conversation: conversationOf(records, cwd, options),
      requestShapes: requestShapesOf(records),
    }),
  };
}

/** True for the transcript of a subagent, which has no subagents of its own to find. */
export function isSubagentFile(file: string): boolean {
  return file.includes('/subagents/');
}

/** The smallest and largest of `values`, NaN when any is NaN, as `Math.min` and `Math.max` give them. */
function range(values: readonly number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return [min, max];
}

/** The text of the person's first prompt: from a `human` origin, or, in the older format, plain text. */
function firstPromptOf(records: readonly Record<string, unknown>[]): string | undefined {
  const first = records.find((r) => {
    if (r['type'] !== 'user' || r['isMeta']) return false;
    const origin = r['origin'];
    if (isRecord(origin) && origin['kind'] === 'human') return true;
    const message = r['message'];
    const content = isRecord(message) ? message['content'] : undefined;
    return !origin && typeof content === 'string' && !content.startsWith('<');
  });
  if (first === undefined) return undefined;
  const message = first['message'];
  return textOf(isRecord(message) ? message['content'] : undefined);
}

function summaryOf(file: string, size: number): SessionSummary {
  const records = readRecords(file).filter(isRecord);
  const times: number[] = [];
  for (const r of records) {
    const timestamp = r['timestamp'];
    if (timestamp) times.push(Date.parse(jsText(timestamp)));
  }
  const [start, end] = range(times);
  const lastTitle = records.findLast((r) => r['type'] === 'ai-title');
  const title = lastTitle === undefined ? undefined : stringOr(lastTitle['aiTitle']);
  const firstPrompt = firstPromptOf(records);
  return {
    id: basename(file, EXT),
    path: file,
    start,
    end,
    size,
    ...(title !== undefined && { title }),
    ...(firstPrompt !== undefined && { firstPrompt }),
  };
}

/** A transcript's summary, and the size and modification time it was read at. */
interface KeptSummary {
  readonly size: number;
  readonly mtimeMs: number;
  readonly summary: SessionSummary;
}

/**
 * Each store's summaries by file name, kept until a transcript's size or modification time changes:
 * the server lists a store again on every load of its index, and a store can hold hundreds of
 * megabytes of transcripts.
 */
const kept = new Map<string, Map<string, KeptSummary>>();

/** The store's sessions with a timestamped record, oldest first; ties keep the directory's order. */
export function listSessions(store: string): SessionSummary[] {
  const before = kept.get(store);
  // Rebuilt from the files there now, so a deleted transcript's summary goes with it.
  const now = new Map<string, KeptSummary>();
  for (const f of readdirSync(store)) {
    if (!f.endsWith(EXT)) continue;
    const file = join(store, f);
    // Stat before reading, so that a write after the stat is read on the next call.
    const { size, mtimeMs } = statSync(file);
    const hit = before?.get(f);
    now.set(f, hit?.size === size && hit.mtimeMs === mtimeMs ? hit : { size, mtimeMs, summary: summaryOf(file, size) });
  }
  kept.set(store, now);
  return [...now.values()]
    .map((k) => k.summary)
    .filter((s) => Number.isFinite(s.start))
    .sort((x, y) => x.start - y.start);
}

/** The store's transcripts that are still there, newest first, from their stats alone. */
function storedSessions(store: string): StoredSession[] {
  return readdirSync(store)
    .filter((f) => f.endsWith(EXT))
    .flatMap((f) => {
      // Undefined for a transcript deleted since the directory was read.
      const stat = statSync(join(store, f), { throwIfNoEntry: false });
      return stat?.isFile() === true ? [{ id: basename(f, EXT), size: stat.size, modified: stat.mtimeMs }] : [];
    })
    .sort((x, y) => y.modified - x.modified);
}

/** The most of a transcript's head read for its working directory. */
const HEAD_BYTES = 64 * 1024;

/** The working directory of the first record in the head of a transcript that names one. */
function headCwd(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    // Deleted since it was listed.
    if (isRecord(err) && err['code'] === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, head, 0, HEAD_BYTES, 0);
    // A record cut off at the end of the head is a partial last line, which parseJsonLines skips.
    for (const r of parseJsonLines(head.toString('utf8', 0, n))) {
      const cwd = isRecord(r) ? r['cwd'] : undefined;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * The root's stores that hold a session, ordered by id: each of its directories, with its
 * transcripts newest first and the project's directory as the newest of them that names one records
 * it. Claude Code keeps the directory of a project that has only its memory left; it is left out.
 */
export function listStores(root: string): StoreSummary[] {
  const stores: StoreSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const sessions = storedSessions(path);
    if (sessions.length === 0) continue;
    let cwd: string | undefined;
    for (const s of sessions) {
      cwd = headCwd(join(path, `${s.id}${EXT}`));
      if (cwd !== undefined) break;
    }
    stores.push({ id: entry.name, path, ...(cwd !== undefined && { cwd }), sessions });
  }
  return stores.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * The transcript `ref` names: an existing file (unless `options.paths` is false); else the one
 * session whose id starts with it; else the one subagent anywhere under the store whose id starts
 * with it.
 */
export function resolve(store: string, ref: string, options: ResolveOptions = {}): string {
  if ((options.paths ?? true) && existsSync(ref) && statSync(ref).isFile()) return ref;
  const top = readdirSync(store).filter((f) => f.endsWith(EXT) && f.startsWith(ref));
  const [only] = top;
  if (only !== undefined && top.length === 1) return join(store, only);
  if (top.length > 1) throw new Error(`"${ref}" matches ${top.length} sessions; give more of the id`);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.startsWith(`agent-${ref}`) && name.endsWith(EXT)) hits.push(path);
    }
  };
  walk(store);
  const [hit] = hits;
  if (hit !== undefined && hits.length === 1) return hit;
  throw new Error(
    hits.length ? `"${ref}" matches ${hits.length} agents` : `no session or agent matches "${ref}" in ${store}`,
  );
}

/** What a subagent's meta file says it was asked to do. */
export interface AgentMeta {
  readonly description?: string;
  readonly workflowPhase?: string;
  readonly agentType?: string;
  readonly requestShape?: string;
}

/** A subagent transcript found under a session. */
export interface FoundAgent {
  readonly file: string;
  readonly agentId: string;
  readonly meta: AgentMeta;
  /** The workflow run it belongs to, from its directory, `subagents/workflows/<runId>/`. */
  readonly workflow?: string;
}

/** A JSON file's object, or `undefined` when the file is missing or holds no JSON object. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function metaOf(file: string): AgentMeta {
  const m = readJsonObject(file) ?? {};
  const description = stringOr(m['description']);
  const workflowPhase = stringOr(m['workflowPhase']);
  const agentType = stringOr(m['agentType']);
  const requestShape = stringOr(m['requestShape']);
  return {
    ...(description !== undefined && { description }),
    ...(workflowPhase !== undefined && { workflowPhase }),
    ...(agentType !== undefined && { agentType }),
    ...(requestShape !== undefined && { requestShape }),
  };
}

/** The directory of a session's own files, beside its transcript. */
function sessionDir(sessionFile: string): string {
  return join(dirname(sessionFile), basename(sessionFile, EXT));
}

/**
 * A stamp of the files `loadSession(file)` reads, which changes whenever any of them changes: their
 * count, total size, and newest modification time. They are the transcript and, for a session's,
 * every file under its directory's `subagents/` and `workflows/`.
 */
export function sessionVersion(file: string): string {
  let count = 0;
  let size = 0;
  let newest = 0;
  const add = (path: string): void => {
    // Undefined for a file that does not exist, or no longer does.
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) add(join(path, name));
      return;
    }
    count++;
    size += stat.size;
    newest = Math.max(newest, stat.mtimeMs);
  };
  add(file);
  if (!isSubagentFile(file)) for (const dir of ['subagents', 'workflows']) add(join(sessionDir(file), dir));
  return `${count}:${size}:${newest}`;
}

/** The subagent transcripts under a session, depth first in the directories' order. */
export function findSubagents(sessionFile: string): FoundAgent[] {
  const dir = join(sessionDir(sessionFile), 'subagents');
  const found: FoundAgent[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^agent-.*\.jsonl$/.test(name)) {
        const workflow = /^workflows\/(wf_[^/]+)/.exec(relative(dir, d))?.[1];
        found.push({
          file: path,
          agentId: name.replace(/^agent-|\.jsonl$/g, ''),
          meta: metaOf(path.replace(/\.jsonl$/, '.meta.json')),
          ...(workflow !== undefined && { workflow }),
        });
      }
    }
  };
  walk(dir);
  return found;
}

/** What a workflow run's summary file says about it. */
export interface WorkflowSummary {
  readonly workflowName?: string;
  readonly status?: string;
  readonly durationMs?: number;
  readonly totalTokens?: number;
  readonly totalToolCalls?: number;
}

/** The summary of the workflow run `runId` of a session; empty when it has none. */
export function workflowSummary(sessionFile: string, runId: string): WorkflowSummary {
  const w = readJsonObject(join(sessionDir(sessionFile), 'workflows', `${runId}.json`)) ?? {};
  const workflowName = stringOr(w['workflowName']);
  const status = stringOr(w['status']);
  const durationMs = numberOr(w['durationMs']);
  const totalTokens = numberOr(w['totalTokens']);
  const totalToolCalls = numberOr(w['totalToolCalls']);
  return {
    ...(workflowName !== undefined && { workflowName }),
    ...(status !== undefined && { status }),
    ...(durationMs !== undefined && { durationMs }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(totalToolCalls !== undefined && { totalToolCalls }),
  };
}
