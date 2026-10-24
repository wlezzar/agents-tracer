import { cpSync } from 'node:fs';
import { join } from 'node:path';

// Where the synthetic fixtures live, for tests in any directory.

/** The fixtures' root, test/fixtures/. */
export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/**
 * A synthetic Claude Code store, as `~/.claude/projects/-home-dev-shop` would be: three sessions
 * (see test/fixtures/claude-code/README.md) and the subagents and workflow run of the first.
 */
export const CLAUDE_CODE_STORE = join(FIXTURES, 'claude-code', 'store');

/** The ids of the fixture store's sessions. */
export const SESSIONS = {
  /** Cart badge: the rich session, spanning midnight, with agents and a workflow run. */
  badge: '5e1f0c2a-8b3d-4c6e-9f7a-1d2b3c4d5e6f',
  /** The older format, without any origin field. */
  oldFormat: '5e9b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  /** A compaction written out of order, a peer prompt, and a partial last line. */
  compaction: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
} as const;

/** The path of a fixture session's transcript. */
export function sessionFile(id: string): string {
  return join(CLAUDE_CODE_STORE, `${id}.jsonl`);
}

/**
 * A synthetic Claude Code store for the conversation (see test/fixtures/claude-code/README.md): one
 * session with what the harness adds, permissions, reasoning, a compaction, and an agent. It is
 * apart from {@link CLAUDE_CODE_STORE}, whose report and view the prototype's expectations hold.
 */
export const CONVERSATION_STORE = join(FIXTURES, 'claude-code', 'conversation');

/** The conversation store's session, and its agent. */
export const CONVERSATION = {
  session: '7a3c9e1f-2b4d-4e6f-8a0b-1c2d3e4f5a6b',
  agent: 'c1d2e3f4a5b6c7d8e',
} as const;

/** The projects {@link copyProjects} writes, named as Claude Code names the stores of `/home/dev/shop` and `/home/dev/blog`. */
export const PROJECTS = { shop: '-home-dev-shop', blog: '-home-dev-blog' } as const;

/**
 * Writes a root of projects into `root`, as `~/.claude/projects` would be: {@link CLAUDE_CODE_STORE}
 * as {@link PROJECTS}' shop and {@link CONVERSATION_STORE} as its blog.
 */
export function copyProjects(root: string): void {
  cpSync(CLAUDE_CODE_STORE, join(root, PROJECTS.shop), { recursive: true });
  cpSync(CONVERSATION_STORE, join(root, PROJECTS.blog), { recursive: true });
}
