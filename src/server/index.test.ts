import { appendFileSync, cpSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claudeCode } from '../adapters/claude-code/index.js';
import { CLAUDE_CODE_STORE, SESSIONS } from '../../test/support/fixtures.js';
import { TEST_VIEWER } from '../../test/support/cli.js';
import { isRecord } from '../util/index.js';
import { HOST, startServer, type RunningServer } from './index.js';

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

async function get(path: string): Promise<{ status: number; type: string | null; body: string }> {
  const res = await fetch(new URL(path, server.url));
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
      expect(data(res.body)).toMatchObject({ serve: true, shellLabel: 'Bash' });
    }
    expect(data((await get(`/s/${SESSIONS.badge}`)).body)['session']).toMatchObject({ id: SESSIONS.badge });
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
