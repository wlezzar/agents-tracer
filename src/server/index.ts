import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Adapter, LoadOptions } from '../model/index.js';
import { oneLine } from '../util/index.js';
import { renderHtml, viewConversation, viewerTemplate, viewSession, type IndexData } from '../view/index.js';

// The loopback server that browses a store's sessions, ported from the prototype's serve: the index
// of the sessions at /, each session's viewer at /s/<id>, and, beyond the prototype, each session's
// conversation at /s/<id>/conversation.

/** Transcripts hold everything the sessions saw, so the server listens on loopback only. */
export const HOST = '127.0.0.1';

/** What the server serves. */
export interface ServerOptions {
  readonly adapter: Adapter;
  /** The store whose sessions it serves. */
  readonly store: string;
  /** The built viewer's page; {@link viewerTemplate} by default. */
  readonly viewer?: () => string;
  /** More tools whose subcommand is part of a shell command's key (util's `shellKey`). */
  readonly subcommandTools?: readonly string[];
}

/** A session's id in a URL: ASCII letters, digits, `_`, and `-`, so never a path. */
const SESSION_ID = /^[\w-]+$/;
const SESSION_PATH = /^\/s\/([\w-]+)(\/conversation)?$/;

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

/**
 * The request handler: GET / is the index, GET /s/<id> a session's viewer, GET /s/<id>/conversation
 * its conversation, anything else a 404. A
 * request addressed to a host other than 127.0.0.1, localhost, or [::1] is refused with a 403, and
 * a method other than GET or HEAD with a 405.
 */
export function createHandler(options: ServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { adapter, store } = options;
  const shell: LoadOptions = options.subcommandTools === undefined ? {} : { subcommandTools: options.subcommandTools };
  const viewer = options.viewer ?? viewerTemplate;
  // Whether the page is a session's conversation, the id it was asked for, and its path -> the page.
  const cache = new Map<string, { version: string; html: string }>();
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
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        const data: IndexData = {
          index: {
            projectDir: store,
            agent: adapter.displayName,
            sessions: adapter.listSessions(store).map((s) => ({
              id: s.id,
              start: s.start,
              end: s.end,
              size: s.size,
              title: s.title ?? null,
              first: oneLine(s.firstPrompt, 200),
              // A session whose id cannot be in a URL is listed without a link.
              href: SESSION_ID.test(s.id) ? `/s/${s.id}` : null,
              conversationHref: SESSION_ID.test(s.id) ? `/s/${s.id}/conversation` : null,
            })),
          },
        };
        send(res, 200, 'text/html; charset=utf-8', renderHtml(data, viewer()));
        return;
      }
      const match = SESSION_PATH.exec(url.pathname);
      const id = match?.[1];
      if (id !== undefined) {
        const conversation = match?.[2] !== undefined;
        let file: string;
        try {
          file = adapter.resolve(store, id, { paths: false });
        } catch (err) {
          send(res, 404, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err));
          return;
        }
        // Kept until the adapter's version of the session changes; built every time without one. The
        // page links to the session by the id it was asked for, so that is part of the key.
        const key = `${conversation ? 'conversation' : 'timeline'}:${id}:${file}`;
        const version = adapter.version?.(file);
        const hit = cache.get(key);
        let html: string;
        if (version !== undefined && hit?.version === version) html = hit.html;
        else {
          html = conversation
            ? renderHtml(
                viewConversation(adapter.load(file, { ...shell, conversation: true }), {
                  serve: true,
                  timelineHref: `/s/${id}`,
                }),
                viewer(),
              )
            : renderHtml(
                viewSession(adapter.load(file, shell), {
                  ...shell,
                  serve: true,
                  conversationHref: `/s/${id}/conversation`,
                }),
                viewer(),
              );
          if (version !== undefined) cache.set(key, { version, html });
        }
        send(res, 200, 'text/html; charset=utf-8', html);
        return;
      }
      send(res, 404, 'text/plain', 'not found');
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
