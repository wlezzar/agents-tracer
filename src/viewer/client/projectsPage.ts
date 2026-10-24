import type { ProjectsData, ViewProject } from '../../view/types.js';
import { byId, el, nodes } from './dom.js';
import { bytes, clock, dayStr } from './format.js';
import { jumpTarget, projectsMatching, sessionsById, type FoundSession } from './projectSearch.js';

// The server's page of every project, under serve --all: the projects, newest activity first,
// filtered as you type, and the sessions whose id starts with what you typed, so that a pasted id
// opens its conversation (Enter goes there when only one matches).

/** The most sessions the search lists. */
const SHOWN = 50;

const UNLINKED = 'The server cannot open this: its id has characters a URL path cannot hold.';

function when(t: number): string {
  return `${dayStr(t)} ${clock(t, false)}`;
}

/** When the project's newest session was last written. */
function lastActive(p: ViewProject): number {
  return Math.max(...p.sessions.map((s) => s.modified));
}

function sessionsTable(found: readonly FoundSession[]): HTMLTableElement {
  return el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: 'Last written' }),
        el('th', { class: 'num', text: 'Size' }),
        el('th', { text: 'Session' }),
        el('th', { text: 'Project' }),
        el('th', { text: '' }),
      ),
    ),
    el(
      'tbody',
      {},
      found.map(({ session: s, project: p }) => {
        const { href, conversationHref } = s;
        return el(
          'tr',
          conversationHref === null
            ? { title: UNLINKED }
            : {
                class: 'row',
                onclick: () => {
                  location.href = conversationHref;
                },
              },
          el('td', { class: 'time' }, when(s.modified)),
          el('td', { class: 'num' }, bytes(s.size)),
          el('td', {}, conversationHref === null ? s.id : el('a', { href: conversationHref, text: s.id })),
          el('td', { class: 'wide' }, p.cwd ?? p.id),
          el(
            'td',
            {},
            href === null
              ? null
              : el('a', {
                  href,
                  text: 'Timeline',
                  // The row itself opens the conversation.
                  onclick: (e) => {
                    e.stopPropagation();
                  },
                }),
          ),
        );
      }),
    ),
  );
}

function projectsTable(projects: readonly ViewProject[]): HTMLTableElement {
  return el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: 'Last active' }),
        el('th', { class: 'num', text: 'Sessions' }),
        el('th', { class: 'num', text: 'Size' }),
        el('th', { text: 'Project' }),
      ),
    ),
    el(
      'tbody',
      {},
      projects.map((p) => {
        const { href } = p;
        const label = p.cwd ?? p.id;
        return el(
          'tr',
          href === null
            ? { title: UNLINKED }
            : {
                class: 'row',
                onclick: () => {
                  location.href = href;
                },
              },
          el('td', { class: 'time' }, when(lastActive(p))),
          el('td', { class: 'num' }, p.sessions.length),
          el('td', { class: 'num' }, bytes(p.sessions.reduce((n, s) => n + s.size, 0))),
          el(
            'td',
            { class: 'wide' },
            href === null ? el('span', { text: label }) : el('a', { href, text: label }),
            p.cwd === null ? null : el('span', { class: 'muted' }, `  ${p.id}`),
          ),
        );
      }),
    ),
  );
}

export function renderProjects(data: ProjectsData): void {
  const { root } = data;
  byId('projects', HTMLDivElement).hidden = false;
  const title = `${root.agent} projects`;
  document.title = title;
  byId('projects-title', HTMLHeadingElement).textContent = title;
  byId('projects-dir', HTMLSpanElement).textContent = root.dir;
  const projects = root.projects.slice().sort((a, b) => lastActive(b) - lastActive(a));
  const q = byId('projects-q', HTMLInputElement);
  const sessionsPane = byId('projects-sessions', HTMLDivElement);
  const projectsPane = byId('projects-table', HTMLDivElement);
  const draw = (): void => {
    const found = sessionsById(projects, q.value);
    const matching = projectsMatching(projects, q.value);
    sessionsPane.hidden = found.length === 0;
    sessionsPane.replaceChildren(
      ...nodes(
        found.length === 0
          ? []
          : [
              sessionsTable(found.slice(0, SHOWN)),
              found.length > SHOWN &&
                el('div', { class: 'more muted' }, `${found.length - SHOWN} more; type more of the id`),
            ],
      ),
    );
    projectsPane.hidden = matching.length === 0 && found.length > 0;
    projectsPane.replaceChildren(
      matching.length === 0
        ? el('div', { class: 'muted' }, 'No project’s directory or id holds this, and no session’s id starts with it.')
        : projectsTable(matching),
    );
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = jumpTarget(projects, q.value);
    if (target !== null) location.href = target;
  });
  draw();
  q.focus();
}
