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
