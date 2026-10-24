import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Adapter, LoadOptions } from '../model/index.js';
import { oneLine } from '../util/index.js';
import {
  renderHtml,
  viewConversation,
  viewerTemplate,
  viewSession,
  type IndexData,
  type PageData,
  type ProjectsData,
} from '../view/index.js';

// The loopback server that browses sessions, ported from the prototype's serve: a store's index of
// sessions at /, each session's viewer at /s/<id>, and, beyond the prototype, each session's
// conversation at /s/<id>/conversation. Beyond the prototype too, it serves every project of a
// root: the projects at /, each project's index and sessions under /p/<project>, and /s/<id> sends
// a session's id to the one project that has it.

/** Transcripts hold everything the sessions saw, so the server listens on loopback only. */
export const HOST = '127.0.0.1';

/** The most characters of HTML the server keeps of the pages it built, by default. */
export const CACHE_CHARS = 100_000_000;

/** What the server serves: one store's sessions, or every project's of a root. */
export type ServerOptions = {
  readonly adapter: Adapter;
  /** The built viewer's page; {@link viewerTemplate} by default. */
  readonly viewer?: () => string;
  /** More tools whose subcommand is part of a shell command's key (util's `shellKey`). */
  readonly subcommandTools?: readonly string[];
  /**
   * The most characters of HTML it keeps of the pages it built, the least recently used dropped
   * first; {@link CACHE_CHARS} by default.
   */
  readonly cacheChars?: number;
} & (
  | {
      /** The store whose sessions it serves. */
      readonly store: string;
    }
  | {
      /** The root whose every store it serves, as a project. */
      readonly root: string;
    }
);

/** A project's or a session's id in a URL: ASCII letters, digits, `_`, and `-`, so never a path. */
const URL_ID = /^[\w-]+$/;
const SESSION_PATH = /^\/s\/([\w-]+)(\/conversation)?$/;
const PROJECT_PATH = /^\/p\/([\w-]+)(\/.*)?$/;

/**
 * The hosts a request may be addressed to, on any port (so that a forwarded port works): loopback
 * names only. A page whose domain an attacker points at 127.0.0.1 (DNS rebinding) sends its own
 * domain as the host, so it cannot read the sessions.
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Sent with every response: no sniffing, no caching, no referrer, no framing. */
const HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { ...HEADERS, ...headers, 'content-type': type });
  res.end(body);
}

/** A page of a store's, after the prefix its pages are under: its index, or a session's page. */
type StorePage =
  { readonly kind: 'index' } | { readonly kind: 'session'; readonly id: string; readonly conversation: boolean };

function storePage(path: string): StorePage | undefined {
  if (path === '' || path === '/') return { kind: 'index' };
  const match = SESSION_PATH.exec(path);
  const id = match?.[1];
  return id === undefined ? undefined : { kind: 'session', id, conversation: match?.[2] !== undefined };
}

/**
 * The pages the server built, each kept while its session's version holds, the least recently used
 * dropped first once they hold more than `limit` characters. A map keeps its keys in the order they
 * were set, so a page is set again each time it is used.
 */
function pageCache(limit: number): {
  get(key: string, version: string): string | undefined;
  set(key: string, version: string, html: string): void;
} {
  const pages = new Map<string, { readonly version: string; readonly html: string }>();
  let chars = 0;
  const drop = (key: string): void => {
    const page = pages.get(key);
    if (page === undefined) return;
    pages.delete(key);
    chars -= page.html.length;
  };
  return {
    get(key, version) {
      const page = pages.get(key);
      if (page?.version !== version) return undefined;
      pages.delete(key);
      pages.set(key, page);
      return page.html;
    },
    set(key, version, html) {
      drop(key);
      if (html.length > limit) return;
      pages.set(key, { version, html });
      chars += html.length;
      for (const oldest of pages.keys()) {
        if (chars <= limit) break;
        drop(oldest);
      }
    },
  };
}

/** The index of a store's sessions, whose pages are under `prefix`. */
function indexData(
  adapter: Adapter,
  store: string,
  prefix: string,
  project: Pick<IndexData['index'], 'projectsHref' | 'cwd'>,
): IndexData {
  return {
    index: {
      projectDir: store,
      agent: adapter.displayName,
      sessions: adapter.listSessions(store).map((s) => {
        // A session whose id cannot be in a URL is listed without a link.
        const linked = URL_ID.test(s.id);
        return {
          id: s.id,
          start: s.start,
          end: s.end,
          size: s.size,
          title: s.title ?? null,
          first: oneLine(s.firstPrompt, 200),
          href: linked ? `${prefix}/s/${s.id}` : null,
          conversationHref: linked ? `${prefix}/s/${s.id}/conversation` : null,
        };
      }),
      ...project,
    },
  };
}

/** The page of every project of `root`, each with its sessions for the search by id. */
function projectsData(adapter: Adapter, root: string): ProjectsData {
  return {
    root: {
      dir: root,
      agent: adapter.displayName,
      projects: adapter.listStores(root).map((p) => {
        const linked = URL_ID.test(p.id);
        return {
          id: p.id,
          cwd: p.cwd ?? null,
          href: linked ? `/p/${p.id}` : null,
          sessions: p.sessions.map((s) => {
            const href = linked && URL_ID.test(s.id) ? `/p/${p.id}/s/${s.id}` : null;
            return {
              id: s.id,
              size: s.size,
              modified: s.modified,
              href,
              conversationHref: href === null ? null : `${href}/conversation`,
            };
          }),
        };
      }),
    },
  };
}

/**
 * The request handler. For one store: GET / is the index, GET /s/<id> a session's viewer, GET
 * /s/<id>/conversation its conversation. For a root: GET / is the page of every project, GET
 * /p/<project> a project's index and /p/<project>/s/<id> its sessions' pages, and GET /s/<id>
 * redirects to the one project whose store resolves the id. Anything else is a 404. A request
 * addressed to a host other than 127.0.0.1, localhost, or [::1] is refused with a 403, and a method
 * other than GET or HEAD with a 405.
 */
export function createHandler(options: ServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { adapter } = options;
  const shell: LoadOptions = options.subcommandTools === undefined ? {} : { subcommandTools: options.subcommandTools };
  const viewer = options.viewer ?? viewerTemplate;
  const cache = pageCache(options.cacheChars ?? CACHE_CHARS);

  const html = (res: ServerResponse, data: PageData): void => {
    send(res, 200, 'text/html; charset=utf-8', renderHtml(data, viewer()));
  };
  const missing = (res: ServerResponse, message: string): void => {
    send(res, 404, 'text/plain; charset=utf-8', message);
  };

  /** Serves `page` of `store`, whose pages are under `prefix`: `''` for the one store, `/p/<project>` for a project. */
  const serveStore = (
    res: ServerResponse,
    page: StorePage,
    store: string,
    prefix: string,
    project: Pick<IndexData['index'], 'projectsHref' | 'cwd'> = {},
  ): void => {
    if (page.kind === 'index') {
      html(res, indexData(adapter, store, prefix, project));
      return;
    }
    const { id, conversation } = page;
    let file: string;
    try {
      file = adapter.resolve(store, id, { paths: false });
    } catch (err) {
      missing(res, err instanceof Error ? err.message : String(err));
      return;
    }
    // Kept until the adapter's version of the session changes; built every time without one. The
    // page links to the session by the id it was asked for and under its prefix, so both are part
    // of the key.
    const key = `${prefix}:${conversation ? 'conversation' : 'timeline'}:${id}:${file}`;
    const version = adapter.version?.(file);
    let body = version === undefined ? undefined : cache.get(key, version);
    if (body === undefined) {
      const base = `${prefix}/s/${id}`;
      const indexHref = prefix === '' ? '/' : prefix;
      body = conversation
        ? renderHtml(
            viewConversation(adapter.load(file, { ...shell, conversation: true }), {
              serve: true,
              timelineHref: base,
              indexHref,
            }),
            viewer(),
          )
        : renderHtml(
            viewSession(adapter.load(file, shell), {
              ...shell,
              serve: true,
              conversationHref: `${base}/conversation`,
              indexHref,
            }),
            viewer(),
          );
      if (version !== undefined) cache.set(key, version, body);
    }
    send(res, 200, 'text/html; charset=utf-8', body);
  };

  /** Serves `path` of every project of `root`. */
  const serveRoot = (res: ServerResponse, path: string, root: string): void => {
    if (path === '/') {
      html(res, projectsData(adapter, root));
      return;
    }
    const search = SESSION_PATH.exec(path);
    const ref = search?.[1];
    if (ref !== undefined) {
      // A store's resolve also fails when the ref is a prefix of several of its sessions, hence "single".
      const found = adapter.listStores(root).filter((p) => {
        if (!URL_ID.test(p.id)) return false;
        try {
          adapter.resolve(p.path, ref, { paths: false });
          return true;
        } catch {
          return false;
        }
      });
      const [only] = found;
      if (only !== undefined && found.length === 1)
        send(res, 302, 'text/plain; charset=utf-8', '', {
          location: `/p/${only.id}/s/${ref}${search?.[2] ?? ''}`,
        });
      else if (found.length > 1)
        missing(res, `"${ref}" matches sessions in ${found.length} projects; give more of the id`);
      else missing(res, `no single session or agent matches "${ref}" in any project in ${root}`);
      return;
    }
    const match = PROJECT_PATH.exec(path);
    const id = match?.[1];
    const page = id === undefined ? undefined : storePage(match?.[2] ?? '');
    if (id === undefined || page === undefined) {
      send(res, 404, 'text/plain', 'not found');
      return;
    }
    // Found by its id among the root's stores, never by a path made from the URL.
    const project = adapter.listStores(root).find((p) => p.id === id);
    if (project === undefined) {
      missing(res, `no project "${id}" in ${root}`);
      return;
    }
    serveStore(res, page, project.path, `/p/${id}`, {
      projectsHref: '/',
      ...(project.cwd !== undefined && { cwd: project.cwd }),
    });
  };

  return (req, res) => {
    try {
      if (!LOOPBACK_HOST.test(req.headers.host ?? '')) {
        send(res, 403, 'text/plain', 'forbidden: this server answers requests to 127.0.0.1 or localhost only');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'text/plain', 'method not allowed', { allow: 'GET, HEAD' });
        return;
      }
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if ('root' in options) {
        serveRoot(res, pathname, options.root);
        return;
      }
      const page = storePage(pathname);
      if (page === undefined) send(res, 404, 'text/plain', 'not found');
      else serveStore(res, page, options.store, '');
    } catch (err) {
      send(res, 500, 'text/plain', err instanceof Error ? err.message : String(err));
    }
  };
}

/** A server that is listening. */
export interface RunningServer {
  readonly server: Server;
  /** The port it listens on, which the system picks when asked for port 0. */
  readonly port: number;
  readonly url: string;
  /** Stops listening and drops open connections. */
  close(): Promise<void>;
}

/** Starts serving on 127.0.0.1 at `port`; rejects when it cannot listen, as when the port is taken. */
export function startServer(options: ServerOptions & { readonly port: number }): Promise<RunningServer> {
  const server = createServer(createHandler(options));
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(options.port, HOST, () => {
      server.off('error', fail);
      const address = server.address();
      const port = isAddress(address) ? address.port : options.port;
      done({
        server,
        port,
        url: `http://${HOST}:${port}/`,
        close: () =>
          new Promise<void>((closed) => {
            server.close(() => {
              closed();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}

function isAddress(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === 'object' && address !== null;
}
