import type { IndexData } from '../../view/types.js';
import { byId, el } from './dom.js';
import { clock, dayStr, fmt, oneLine } from './format.js';

// The server's index page: a store's sessions, newest first, filtered as you type, and a link to
// the projects page when the store is one of them.

export function renderIndex(data: IndexData): void {
  const { index } = data;
  byId('index', HTMLDivElement).hidden = false;
  const title = `${index.agent} sessions`;
  document.title = title;
  byId('index-title', HTMLHeadingElement).textContent = title;
  byId('index-dir', HTMLSpanElement).textContent = index.cwd ?? index.projectDir;
  const back = byId('index-back', HTMLAnchorElement);
  if (index.projectsHref !== undefined) {
    back.href = index.projectsHref;
    back.hidden = false;
  }
  const rows = index.sessions.slice().sort((a, b) => b.start - a.start);
  const q = byId('index-q', HTMLInputElement);
  const draw = (): void => {
    const text = q.value.toLowerCase();
    const shown = rows.filter((r) => !text || `${r.id} ${r.title ?? ''} ${r.first}`.toLowerCase().includes(text));
    const body = el(
      'tbody',
      {},
      shown.map((r) => {
        const { href, conversationHref } = r;
        // A session the server cannot open (its id cannot be in a URL) is listed without a link.
        const label = r.title !== null && r.title !== '' ? r.title : oneLine(r.first, 160) || '(no prompt)';
        return el(
          'tr',
          href === null
            ? { title: 'The server cannot open this session: its id has characters a URL path cannot hold.' }
            : {
                class: 'row',
                onclick: () => {
                  location.href = href;
                },
              },
          el('td', { class: 'time' }, `${dayStr(r.start)} ${clock(r.start, false)}`),
          el('td', { class: 'num' }, fmt(r.end - r.start)),
          el('td', { class: 'num' }, `${Math.round(r.size / 1024)}K`),
          el(
            'td',
            { class: 'wide' },
            // An empty title falls through to the first prompt, as in the prototype.
            href === null ? el('span', { text: label }) : el('a', { href, text: label }),
            r.title && r.first ? el('span', { class: 'muted' }, `  ${oneLine(r.first, 120)}`) : null,
          ),
          el(
            'td',
            {},
            conversationHref === null
              ? null
              : el('a', {
                  href: conversationHref,
                  text: 'Conversation',
                  // The row itself opens the timeline.
                  onclick: (e) => {
                    e.stopPropagation();
                  },
                }),
          ),
          el('td', { class: 'muted' }, r.id.slice(0, 8)),
        );
      }),
    );
    byId('index-table', HTMLDivElement).replaceChildren(
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: 'Started' }),
            el('th', { class: 'num', text: 'Wall' }),
            el('th', { class: 'num', text: 'Size' }),
            el('th', { text: 'Title / first prompt' }),
            el('th', { text: '' }),
            el('th', { text: 'Session' }),
          ),
        ),
        body,
      ),
    );
  };
  q.addEventListener('input', draw);
  draw();
}
