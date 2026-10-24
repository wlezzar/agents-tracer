import type { ViewProject, ViewProjectSession } from '../../view/types.js';

// The projects page's search: the projects whose directory or id holds what was typed, and the
// sessions whose id starts with it, so that a pasted session id finds its project and its pages.

/** A session the search found, with its project. */
export interface FoundSession {
  readonly session: ViewProjectSession;
  readonly project: ViewProject;
}

function normal(query: string): string {
  return query.trim().toLowerCase();
}

/** The sessions whose id starts with `query`, newest first, each with its project; none for an empty query. */
export function sessionsById(projects: readonly ViewProject[], query: string): FoundSession[] {
  const q = normal(query);
  if (q === '') return [];
  return projects
    .flatMap((project) =>
      project.sessions.filter((s) => s.id.toLowerCase().startsWith(q)).map((session) => ({ session, project })),
    )
    .sort((a, b) => b.session.modified - a.session.modified);
}

/** The projects whose directory or id holds `query`; every project for an empty query. */
export function projectsMatching(projects: readonly ViewProject[], query: string): ViewProject[] {
  const q = normal(query);
  return projects.filter((p) => (p.cwd ?? '').toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
}

/**
 * Where Enter in the search goes: the conversation of the only session whose id starts with
 * `query`, else the index of the only project that matches it, else nowhere (null).
 */
export function jumpTarget(projects: readonly ViewProject[], query: string): string | null {
  const sessions = sessionsById(projects, query);
  const [session] = sessions;
  if (session !== undefined && sessions.length === 1) return session.session.conversationHref;
  const matching = projectsMatching(projects, query);
  const [project] = matching;
  return project !== undefined && matching.length === 1 ? project.href : null;
}
