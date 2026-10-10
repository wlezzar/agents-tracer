// A test-only adapter that serves sessions built in memory, from neutral events, so tests of the
// analysis, the report, and the view run without any agent's transcript format. It is the example
// of docs/adapters.md, and it is not shipped: nothing in src/ imports it.

import type {
  Adapter,
  AgentTranscript,
  Compaction,
  Group,
  Session,
  SessionSummary,
  ToolCall,
  ToolCategory,
  ToolDescription,
  Transcript,
  TraceEvent,
} from '../../src/model/index.js';

/** The adapter id of the sessions this adapter serves. */
export const MEMORY_ADAPTER_ID = 'memory';

/** A transcript from events, with its id as its path. */
export function transcript(
  id: string,
  events: readonly TraceEvent[],
  extra: { readonly title?: string; readonly cwd?: string; readonly compactions?: readonly Compaction[] } = {},
): Transcript {
  const { compactions = [], ...rest } = extra;
  return { id, path: `memory:${id}`, events, compactions, ...rest };
}

/** A session of a main transcript and, optionally, agents and groups. */
export function session(
  main: Transcript,
  extra: {
    readonly agents?: readonly AgentTranscript[];
    readonly groups?: readonly Group[];
    readonly shellToolName?: string;
  } = {},
): Session {
  return {
    adapter: MEMORY_ADAPTER_ID,
    main,
    agents: extra.agents ?? [],
    groups: extra.groups ?? [],
    ...(extra.shellToolName !== undefined && { shellToolName: extra.shellToolName }),
  };
}

/** A tool call whose description has the given category and, unless given, empty texts. */
export function toolCall(
  id: string,
  name: string,
  category: ToolCategory,
  desc: Partial<Omit<ToolDescription, 'category'>> = {},
  input: Readonly<Record<string, unknown>> = {},
): ToolCall {
  return { id, name, input, desc: { preview: '', inputText: '', ...desc, category } };
}

/**
 * An adapter over sessions held in memory: its store is ignored, a session's ref is its main
 * transcript's id or a unique prefix of one, and its path is that transcript's path.
 */
export function createMemoryAdapter(sessions: readonly Session[]): Adapter {
  const byPath = new Map(sessions.map((s) => [s.main.path, s]));
  const summary = (s: Session): SessionSummary | undefined => {
    const times = s.main.events.map((e) => e.ts);
    if (times.length === 0) return undefined;
    const first = s.main.events.find((e) => e.kind === 'prompt');
    return {
      id: s.main.id,
      path: s.main.path,
      start: Math.min(...times),
      end: Math.max(...times),
      size: 0,
      ...(s.main.title !== undefined && { title: s.main.title }),
      ...(first !== undefined && { firstPrompt: first.text }),
    };
  };
  return {
    id: MEMORY_ADAPTER_ID,
    displayName: 'Memory',
    defaultStore: () => 'memory:',
    listSessions: () => sessions.flatMap((s) => summary(s) ?? []).sort((a, b) => a.start - b.start),
    resolve: (_store, ref, options = {}) => {
      const paths = options.paths ?? true;
      const hits = sessions.filter((s) => s.main.id.startsWith(ref) || (paths && s.main.path === ref));
      const [hit, ...rest] = hits;
      if (hit === undefined) throw new Error(`no session matches "${ref}" in memory`);
      if (rest.length > 0) throw new Error(`"${ref}" matches ${hits.length} sessions; give more of the id`);
      return hit.main.path;
    },
    load: (path) => {
      const found = byPath.get(path);
      if (found === undefined) throw new Error(`no session at ${path}`);
      return found;
    },
    // Its sessions never change.
    version: () => 'memory',
  };
}
