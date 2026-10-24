import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claudeCode } from '../adapters/claude-code/index.js';
import { CLAUDE_CODE_STORE, CONVERSATION, copyProjects, PROJECTS, SESSIONS } from '../../test/support/fixtures.js';
import { TEST_VIEWER } from '../../test/support/cli.js';
import { isRecord } from '../util/index.js';
import { CACHE_CHARS, HOST, startServer, type RunningServer } from './index.js';

// The server over a copy of the fixture store (so a test can touch a transcript), on a port the
// system picks.

const store = mkdtempSync(join(tmpdir(), 'agents-tracer-serve-'));
cpSync(CLAUDE_CODE_STORE, store, { recursive: true });
let server: RunningServer;
let renders = 0;

beforeAll(async () => {
  server = await startServer({
    adapter: claudeCode,
    store,
    port: 0,
    viewer: () => {
      renders++;
      return TEST_VIEWER;
    },
  });
});
afterAll(async () => {
  await server.close();
  rmSync(store, { recursive: true, force: true });
});

async function get(path: string, on = server): Promise<{ status: number; type: string | null; body: string }> {
  const res = await fetch(new URL(path, on.url));
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

/** A request with the given method and Host header, which fetch does not let a caller set. */
function raw(
  path: string,
  { method = 'GET', host }: { readonly method?: string; readonly host: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: HOST, port: server.port, path, method, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        done({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', fail);
    req.end();
  });
}

function data(html: string): Record<string, unknown> {
  const json = /application\/json">(.*)<\/script>/s.exec(html)?.[1];
  const parsed: unknown = JSON.parse(json ?? 'null');
  if (!isRecord(parsed)) throw new Error('no data');
  return parsed;
}

describe('the server', () => {
  it('listens on 127.0.0.1 only', () => {
    const address = server.server.address();
    expect(typeof address === 'object' && address !== null ? address.address : address).toBe(HOST);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });

  it('serves the index of the store’s sessions at /', async () => {
    const res = await get('/');
    expect(res).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    const { index } = data(res.body);
    expect(index).toMatchObject({ projectDir: store, agent: 'Claude Code' });
    expect(isRecord(index) && Array.isArray(index['sessions']) ? index['sessions'] : []).toEqual([
      expect.objectContaining({
        id: SESSIONS.oldFormat,
        title: null,
        first: 'Add a test for the cart total',
        href: `/s/${SESSIONS.oldFormat}`,
        conversationHref: `/s/${SESSIONS.oldFormat}/conversation`,
      }),
      expect.objectContaining({ id: SESSIONS.compaction, title: 'Cart store reducer' }),
      expect.objectContaining({
        id: SESSIONS.badge,
        title: 'Cart badge in the header',
        first: 'Add a cart badge to the header that shows how many items are in the cart',
      }),
    ]);
  });

  it('serves a session’s viewer at /s/<id>, by a prefix of its id or an agent’s id too', async () => {
    for (const id of [SESSIONS.badge, '5e1f', 'a1b2']) {
      const res = await get(`/s/${id}`);
      expect(res).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
      expect(data(res.body)).toMatchObject({ serve: true, shellLabel: 'Bash', indexHref: '/' });
    }
    expect(data((await get(`/s/${SESSIONS.badge}`)).body)['session']).toMatchObject({ id: SESSIONS.badge });
    expect(data((await get('/s/5e1f')).body)).toMatchObject({ conversationHref: '/s/5e1f/conversation' });
  });

  it('serves a session’s conversation at /s/<id>/conversation, linked to its timeline', async () => {
    const res = await get('/s/5e1f/conversation');
    expect(res).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    const page = data(res.body);
    expect(page).toMatchObject({ serve: true, timelineHref: '/s/5e1f', indexHref: '/' });
    const conversation = page['conversation'];
    expect(conversation).toMatchObject({ session: { id: SESSIONS.badge }, shellLabel: 'Bash' });
    const threads = isRecord(conversation) && Array.isArray(conversation['threads']) ? conversation['threads'] : [];
    expect(threads.map((t) => (isRecord(t) ? t['id'] : null))).toContain('a1b2c3d4e5f6a7b8c');
    // The timeline and the conversation are kept apart.
    const before = renders;
    await get('/s/5e1f/conversation');
    await get('/s/5e1f');
    expect(renders).toBe(before);
    expect((await get('/s/zz/conversation')).status).toBe(404);
  });

  it('caches a session’s page until its transcript changes', async () => {
    await get(`/s/${SESSIONS.compaction}`);
    const before = renders;
    await get(`/s/${SESSIONS.compaction}`);
    expect(renders).toBe(before);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(store, `${SESSIONS.compaction}.jsonl`), later, later);
    await get(`/s/${SESSIONS.compaction}`);
    expect(renders).toBe(before + 1);
  });

  it('rebuilds a session’s page when one of its subagents’ transcripts changes', async () => {
    const agent = join(store, SESSIONS.badge, 'subagents', 'agent-a1b2c3d4e5f6a7b8c.jsonl');
    const lane = async (): Promise<unknown> => {
      const lanes: unknown = data((await get(`/s/${SESSIONS.badge}`)).body)['lanes'];
      const list: readonly unknown[] = Array.isArray(lanes) ? lanes : [];
      return list.find((l) => isRecord(l) && l['id'] === 'a1b2c3d4e5f6a7b8c');
    };
    const before = await lane();
    const renderedBefore = renders;
    await lane();
    expect(renders).toBe(renderedBefore);
    const late = { type: 'user', timestamp: '2026-03-15T03:30:00.000Z', message: { role: 'user', content: 'late' } };
    appendFileSync(agent, `${JSON.stringify(late)}\n`);
    const after = await lane();
    expect(renders).toBe(renderedBefore + 1);
    expect(isRecord(before) && isRecord(after) && after['end'] !== before['end']).toBe(true);
  });

  it('answers 404 for an id that names no session, with the reason', async () => {
    expect(await get('/s/zz')).toEqual({
      status: 404,
      type: 'text/plain; charset=utf-8',
      body: `no session or agent matches "zz" in ${store}`,
    });
    expect((await get('/s/5e')).body).toBe('"5e" matches 2 sessions; give more of the id');
  });

  it('answers 404 for anything else, a path in place of an id included', async () => {
    for (const path of [
      '/s/',
      '/s/a/b',
      '/s/5e1f/conversation/x',
      '/s/5e1f/conversations',
      '/s/..%2Fetc',
      `/s/${encodeURIComponent(join(store, `${SESSIONS.badge}.jsonl`))}`,
      '/x',
    ])
      expect(await get(path)).toEqual({ status: 404, type: 'text/plain', body: 'not found' });
  });

  it('refuses a request addressed to another host, so a rebound domain cannot read the sessions', async () => {
    for (const host of ['attacker.example', `attacker.example:${server.port}`, '127.0.0.1.evil.example', 'localhost@x'])
      for (const path of ['/', `/s/${SESSIONS.badge}`])
        expect(await raw(path, { host })).toMatchObject({
          status: 403,
          body: 'forbidden: this server answers requests to 127.0.0.1 or localhost only',
        });
  });

  it('answers a request addressed to a loopback name, on any port', async () => {
    for (const host of ['127.0.0.1', `127.0.0.1:${server.port}`, 'localhost:8080', 'LOCALHOST', '[::1]:4390'])
      expect((await raw('/', { host })).status).toBe(200);
  });

  it('answers GET and HEAD only', async () => {
    const host = `127.0.0.1:${server.port}`;
    for (const method of ['POST', 'PUT', 'DELETE'])
      expect(await raw('/', { method, host })).toMatchObject({
        status: 405,
        headers: { allow: 'GET, HEAD' },
        body: 'method not allowed',
      });
    expect(await raw(`/s/${SESSIONS.badge}`, { method: 'HEAD', host })).toMatchObject({ status: 200, body: '' });
  });

  it('asks browsers not to sniff, cache, refer, or frame on every response', async () => {
    const host = `127.0.0.1:${server.port}`;
    for (const path of ['/', `/s/${SESSIONS.badge}`, '/s/zz', '/x'])
      expect((await raw(path, { host })).headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      });
  });
});

describe('the server of every project in a root', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-tracer-serve-root-'));
  copyProjects(root);
  const shop = `/p/${PROJECTS.shop}`;
  const blog = `/p/${PROJECTS.blog}`;
  const copy = '-home-dev-shop-copy';
  cpSync(CLAUDE_CODE_STORE, join(root, copy), { recursive: true });
  // A dot cannot be in a URL's id, so the project is listed without a link.
  const dotted = '-home-dev-my.app';
  mkdirSync(join(root, dotted));
  cpSync(join(CLAUDE_CODE_STORE, `${SESSIONS.oldFormat}.jsonl`), join(root, dotted, `${SESSIONS.oldFormat}.jsonl`));
  for (const [id, minute] of [
    [SESSIONS.badge, 3],
    [SESSIONS.compaction, 2],
    [SESSIONS.oldFormat, 1],
  ] as const) {
    const at = new Date(Date.UTC(2026, 2, 20, 9, minute));
    utimesSync(join(root, PROJECTS.shop, `${id}.jsonl`), at, at);
  }
  let rooted: RunningServer;
  beforeAll(async () => {
    rooted = await startServer({ adapter: claudeCode, root, port: 0, viewer: () => TEST_VIEWER });
  });
  afterAll(async () => {
    await rooted.close();
    rmSync(root, { recursive: true, force: true });
  });
  const at = (path: string) => get(path, rooted);
  const redirect = async (path: string): Promise<{ status: number; location: string | null }> => {
    const res = await fetch(new URL(path, rooted.url), { redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') };
  };
  const linked = (project: string, id: string) => ({
    id,
    href: `${project}/s/${id}`,
    conversationHref: `${project}/s/${id}/conversation`,
  });

  it('serves every project at /, by id, each with its sessions newest first', async () => {
    const res = await at('/');
    expect(res).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    expect(data(res.body)).toMatchObject({
      root: {
        dir: root,
        agent: 'Claude Code',
        projects: [
          { id: PROJECTS.blog, cwd: '/home/dev/shop', href: blog, sessions: [linked(blog, CONVERSATION.session)] },
          { id: dotted, href: null, sessions: [{ id: SESSIONS.oldFormat, href: null, conversationHref: null }] },
          {
            id: PROJECTS.shop,
            cwd: '/home/dev/shop',
            href: shop,
            sessions: [
              { ...linked(shop, SESSIONS.badge), modified: Date.UTC(2026, 2, 20, 9, 3) },
              linked(shop, SESSIONS.compaction),
              linked(shop, SESSIONS.oldFormat),
            ],
          },
          { id: copy, href: `/p/${copy}` },
        ],
      },
    });
  });

  it('serves a project’s index at /p/<project>, linked to the projects and its sessions under the project', async () => {
    for (const path of [shop, `${shop}/`]) {
      const res = await at(path);
      expect(res).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
      expect(data(res.body)).toMatchObject({
        index: {
          projectDir: join(root, PROJECTS.shop),
          agent: 'Claude Code',
          projectsHref: '/',
          cwd: '/home/dev/shop',
          sessions: [linked(shop, SESSIONS.oldFormat), linked(shop, SESSIONS.compaction), linked(shop, SESSIONS.badge)],
        },
      });
    }
  });

  it('serves a project’s sessions under /p/<project>, linked back to its index', async () => {
    expect(data((await at(`${shop}/s/5e1f`)).body)).toMatchObject({
      serve: true,
      session: { id: SESSIONS.badge },
      conversationHref: `${shop}/s/5e1f/conversation`,
      indexHref: shop,
    });
    expect(data((await at(`${blog}/s/7a3c/conversation`)).body)).toMatchObject({
      serve: true,
      conversation: { session: { id: CONVERSATION.session } },
      timelineHref: `${blog}/s/7a3c`,
      indexHref: blog,
    });
    expect(await at(`${blog}/s/5e1f`)).toEqual({
      status: 404,
      type: 'text/plain; charset=utf-8',
      body: `no session or agent matches "5e1f" in ${join(root, PROJECTS.blog)}`,
    });
  });

  it('sends /s/<id> to the one project that has the session or agent, keeping the id as given', async () => {
    expect(await redirect('/s/7a3c/conversation')).toEqual({ status: 302, location: `${blog}/s/7a3c/conversation` });
    expect(await redirect('/s/7a3c')).toEqual({ status: 302, location: `${blog}/s/7a3c` });
    expect(await redirect(`/s/${CONVERSATION.agent.slice(0, 6)}`)).toEqual({
      status: 302,
      location: `${blog}/s/${CONVERSATION.agent.slice(0, 6)}`,
    });
    const followed = await at('/s/7a3c/conversation');
    expect(followed.status).toBe(200);
    expect(data(followed.body)).toMatchObject({ conversation: { session: { id: CONVERSATION.session } } });
  });

  it('answers 404 for an id that several projects have, or none has once', async () => {
    // The project without a link holds the session too, but it cannot be sent there.
    expect(await at('/s/5e9b')).toEqual({
      status: 404,
      type: 'text/plain; charset=utf-8',
      body: '"5e9b" matches sessions in 2 projects; give more of the id',
    });
    for (const ref of ['zz', '5e'])
      expect(await at(`/s/${ref}`)).toEqual({
        status: 404,
        type: 'text/plain; charset=utf-8',
        body: `no single session or agent matches "${ref}" in any project in ${root}`,
      });
  });

  it('answers 404 for a project the root does not have, and for anything else', async () => {
    for (const path of ['/p/-home-dev-nope', '/p/-home-dev-nope/s/5e1f'])
      expect(await at(path)).toEqual({
        status: 404,
        type: 'text/plain; charset=utf-8',
        body: `no project "-home-dev-nope" in ${root}`,
      });
    for (const path of [
      '/p/',
      `/p/${dotted}`,
      `/p/${encodeURIComponent(join(root, PROJECTS.shop))}`,
      '/p/..%2F..',
      `${shop}/x`,
      `${shop}/s/`,
      `${shop}/s/5e1f/x`,
      '/s/5e1f/x',
      '/x',
    ])
      expect(await at(path)).toEqual({ status: 404, type: 'text/plain', body: 'not found' });
  });
});

describe('the page cache', () => {
  const [a, b, c] = [`/s/${SESSIONS.oldFormat}`, `/s/${SESSIONS.compaction}`, `/s/${SESSIONS.badge}`];

  /** Opens `paths` on a server of the fixture store that keeps `cacheChars` characters of pages, and counts the pages it built. */
  async function opened(cacheChars: number, paths: readonly string[]): Promise<{ renders: number; lengths: number[] }> {
    let renders = 0;
    const running = await startServer({
      adapter: claudeCode,
      store: CLAUDE_CODE_STORE,
      port: 0,
      cacheChars,
      viewer: () => {
        renders++;
        return TEST_VIEWER;
      },
    });
    try {
      const lengths: number[] = [];
      for (const path of paths) lengths.push((await get(path, running)).body.length);
      return { renders, lengths };
    } finally {
      await running.close();
    }
  }
  let lengths: number[] = [];
  beforeAll(async () => {
    ({ lengths } = await opened(CACHE_CHARS, [a, b, c]));
  });
  const length = (i: number): number => lengths[i] ?? 0;

  it('builds a page again once newer pages pushed it out', async () => {
    expect((await opened(Math.max(length(0), length(1)), [a, b, a])).renders).toBe(3);
    expect((await opened(length(0) + length(1), [a, b, a])).renders).toBe(2);
  });

  it('pushes out the page used least recently, not the one built first', async () => {
    expect((await opened(length(0) + Math.max(length(1), length(2)), [a, b, a, c, a, b])).renders).toBe(4);
  });

  it('keeps no page longer than its limit, and keeps the others then', async () => {
    expect(length(2)).toBeGreaterThan(length(0));
    expect((await opened(length(0), [a, a])).renders).toBe(1);
    expect((await opened(length(0), [a, c, c, a])).renders).toBe(3);
  });
});
