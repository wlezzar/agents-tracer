import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_STORE as store,
  CONVERSATION,
  copyProjects,
  PROJECTS,
  SESSIONS,
  sessionFile,
} from '../../../test/support/fixtures.js';
import {
  defaultRoot,
  defaultStore,
  findSubagents,
  listSessions,
  listStores,
  readTranscript,
  resolve,
  sessionVersion,
  workflowSummary,
} from './store.js';

const badgeDir = join(store, SESSIONS.badge);

describe('defaultStore', () => {
  it('names the project by its directory, every character outside [a-zA-Z0-9] a dash', () => {
    expect(defaultStore('/home/dev/shop', '/home/dev')).toBe('/home/dev/.claude/projects/-home-dev-shop');
    expect(defaultStore('/home/dev/my_app.v2', '/home/dev')).toBe('/home/dev/.claude/projects/-home-dev-my-app-v2');
  });
});

describe('defaultRoot', () => {
  it('is the directory of every project’s store', () => {
    expect(defaultRoot('/home/dev')).toBe('/home/dev/.claude/projects');
  });
});

describe('listStores', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-tracer-root-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  copyProjects(root);
  const shop = join(root, PROJECTS.shop);
  const blog = join(root, PROJECTS.blog);
  const written = (dir: string, id: string, minute: number, text?: string): string => {
    const file = join(dir, `${id}.jsonl`);
    if (text !== undefined) writeFileSync(file, text);
    const at = new Date(Date.UTC(2026, 2, 20, 9, minute));
    utimesSync(file, at, at);
    return file;
  };
  const stored = (file: string, id: string, minute: number) => ({
    id,
    size: statSync(file).size,
    modified: Date.UTC(2026, 2, 20, 9, minute),
  });
  const badge = written(shop, SESSIONS.badge, 3);
  const compaction = written(shop, SESSIONS.compaction, 2);
  const oldFormat = written(shop, SESSIONS.oldFormat, 1);
  const conversation = written(blog, CONVERSATION.session, 1);
  // The newest names no working directory, and the next names an empty one before the blog's.
  const unnamed = written(blog, 'e0000000-0000-4000-8000-000000000002', 6, '{"type":"permission-mode"}\n');
  const named = written(
    blog,
    'e0000000-0000-4000-8000-000000000001',
    5,
    '{"type":"permission-mode","cwd":""}\n{"type":"user","cwd":"/home/dev/blog"}\n',
  );
  mkdirSync(join(root, '-home-dev-empty'));
  mkdirSync(join(root, '-home-dev-notes', 'memory'), { recursive: true });
  writeFileSync(join(root, '-home-dev-notes', 'memory', 'x.md'), 'notes');
  writeFileSync(join(root, 'stray.jsonl'), '');

  it('lists the directories that hold a session by id, each with its sessions newest first and its project’s directory', () => {
    expect(listStores(root)).toEqual([
      {
        id: PROJECTS.blog,
        path: blog,
        cwd: '/home/dev/blog',
        sessions: [
          stored(unnamed, 'e0000000-0000-4000-8000-000000000002', 6),
          stored(named, 'e0000000-0000-4000-8000-000000000001', 5),
          stored(conversation, CONVERSATION.session, 1),
        ],
      },
      {
        id: PROJECTS.shop,
        path: shop,
        cwd: '/home/dev/shop',
        sessions: [
          stored(badge, SESSIONS.badge, 3),
          stored(compaction, SESSIONS.compaction, 2),
          stored(oldFormat, SESSIONS.oldFormat, 1),
        ],
      },
    ]);
  });

  it('throws when the root cannot be read', () => {
    expect(() => listStores(join(root, 'missing'))).toThrow(/ENOENT/);
  });
});

describe('listSessions', () => {
  it('lists the sessions oldest first, with their times, title, first prompt, and size', () => {
    const sessions = listSessions(store);
    expect(sessions.map(({ size: _, ...s }) => s)).toEqual([
      {
        id: SESSIONS.oldFormat,
        path: sessionFile(SESSIONS.oldFormat),
        start: Date.parse('2026-03-10T09:00:00.000Z'),
        end: Date.parse('2026-03-10T09:06:40.000Z'),
        firstPrompt: 'Add a test for the cart total',
      },
      {
        id: SESSIONS.compaction,
        path: sessionFile(SESSIONS.compaction),
        start: Date.parse('2026-03-12T14:00:00.000Z'),
        end: Date.parse('2026-03-12T14:20:08.000Z'),
        title: 'Cart store reducer',
        firstPrompt: 'Refactor the cart store to use a reducer',
      },
      {
        id: SESSIONS.badge,
        path: sessionFile(SESSIONS.badge),
        start: Date.parse('2026-03-14T22:50:00.000Z'),
        end: Date.parse('2026-03-15T00:21:20.000Z'),
        title: 'Cart badge in the header',
        firstPrompt: 'Add a cart badge to the header that shows how many items are in the cart',
      },
    ]);
    expect(sessions.every((s) => s.size > 0)).toBe(true);
  });

  describe('in a store with sessions that have no timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-tracer-'));
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('leaves them out, and reads no other files', () => {
      writeFileSync(join(dir, 'empty.jsonl'), '');
      writeFileSync(join(dir, 'untimed.jsonl'), '{"type":"ai-title","aiTitle":"No time"}\n');
      writeFileSync(join(dir, 'notes.txt'), 'not a transcript');
      writeFileSync(join(dir, 'one.jsonl'), '{"type":"user","timestamp":"2026-01-02T03:04:05.000Z"}\n{"partial');
      expect(listSessions(dir).map((s) => [s.id, s.start, s.end, s.firstPrompt])).toEqual([
        ['one', Date.parse('2026-01-02T03:04:05.000Z'), Date.parse('2026-01-02T03:04:05.000Z'), undefined],
      ]);
    });
  });
});

describe('listSessions over a store that changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-tracer-changes-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  cpSync(store, dir, { recursive: true });
  const listed = (at: string) => listSessions(at).map((s) => ({ ...s, path: relative(at, s.path) }));
  /** What a store never listed before lists for the same files. */
  const unseen = () => {
    const copy = mkdtempSync(join(tmpdir(), 'agents-tracer-unseen-'));
    try {
      cpSync(dir, copy, { recursive: true });
      return listed(copy);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  };

  it('reads a transcript again once it is written to, and leaves out one that is deleted', () => {
    expect(listed(dir)).toEqual(unseen());
    const late = { type: 'user', timestamp: '2026-03-16T08:00:00.000Z', message: { role: 'user', content: 'Later' } };
    appendFileSync(join(dir, `${SESSIONS.oldFormat}.jsonl`), `\n${JSON.stringify(late)}\n`);
    expect(listed(dir).find((s) => s.id === SESSIONS.oldFormat)?.end).toBe(Date.parse(late.timestamp));
    expect(listed(dir)).toEqual(unseen());
    rmSync(join(dir, `${SESSIONS.compaction}.jsonl`));
    expect(listed(dir).map((s) => s.id)).toEqual([SESSIONS.oldFormat, SESSIONS.badge]);
    expect(listed(dir)).toEqual(unseen());
  });
});

describe('resolve', () => {
  it('takes an existing file as it is', () => {
    expect(resolve(store, sessionFile(SESSIONS.badge))).toBe(sessionFile(SESSIONS.badge));
  });

  it('takes no path with paths: false, only ids', () => {
    expect(() => resolve(store, sessionFile(SESSIONS.badge), { paths: false })).toThrow(
      `no session or agent matches "${sessionFile(SESSIONS.badge)}" in ${store}`,
    );
    expect(resolve(store, '5e1', { paths: false })).toBe(sessionFile(SESSIONS.badge));
  });

  it('finds a session by a unique prefix of its id', () => {
    expect(resolve(store, '5e1')).toBe(sessionFile(SESSIONS.badge));
    expect(resolve(store, SESSIONS.compaction)).toBe(sessionFile(SESSIONS.compaction));
  });

  it('finds a subagent anywhere under the store by a unique prefix of its id', () => {
    expect(relative(store, resolve(store, 'a1'))).toBe(`${SESSIONS.badge}/subagents/agent-a1b2c3d4e5f6a7b8c.jsonl`);
    expect(relative(store, resolve(store, 'ab12'))).toBe(
      `${SESSIONS.badge}/subagents/workflows/wf_3e9a1c7b-5d2/agent-ab12cd34ef56ab78c.jsonl`,
    );
  });

  it('says how many matched, or that none did', () => {
    expect(() => resolve(store, '5e')).toThrow('"5e" matches 2 sessions; give more of the id');
    expect(() => resolve(store, 'a')).toThrow('"a" matches 4 agents');
    expect(() => resolve(store, 'zz')).toThrow(`no session or agent matches "zz" in ${store}`);
  });
});

describe('findSubagents', () => {
  it("finds a session's subagents, their meta files, and their workflow runs", () => {
    const found = findSubagents(sessionFile(SESSIONS.badge)).sort((a, b) => a.agentId.localeCompare(b.agentId));
    expect(found.map((f) => ({ ...f, file: relative(badgeDir, f.file) }))).toEqual([
      {
        file: 'subagents/agent-a1b2c3d4e5f6a7b8c.jsonl',
        agentId: 'a1b2c3d4e5f6a7b8c',
        meta: { description: 'Review the cart badge', agentType: 'general-purpose', requestShape: 'background' },
      },
      {
        file: 'subagents/agent-a9f8e7d6c5b4a3921.jsonl',
        agentId: 'a9f8e7d6c5b4a3921',
        meta: { description: 'Check the badge styles', agentType: 'Explore', requestShape: 'background' },
      },
      {
        file: 'subagents/workflows/wf_3e9a1c7b-5d2/agent-ab12cd34ef56ab78c.jsonl',
        agentId: 'ab12cd34ef56ab78c',
        meta: {
          description: 'Plan tests for CartBadge',
          workflowPhase: 'plan',
          agentType: 'workflow-subagent',
          requestShape: 'foreground',
        },
        workflow: 'wf_3e9a1c7b-5d2',
      },
      {
        file: 'subagents/workflows/wf_3e9a1c7b-5d2/agent-ac98ba76dc54fe32a.jsonl',
        agentId: 'ac98ba76dc54fe32a',
        meta: {
          description: 'Write tests for CartBadge',
          workflowPhase: 'write',
          agentType: 'workflow-subagent',
          requestShape: 'foreground',
        },
        workflow: 'wf_3e9a1c7b-5d2',
      },
    ]);
  });

  it('finds none for a session without a subagents directory', () => {
    expect(findSubagents(sessionFile(SESSIONS.oldFormat))).toEqual([]);
  });
});

describe('workflowSummary', () => {
  it("reads a workflow run's summary", () => {
    expect(workflowSummary(sessionFile(SESSIONS.badge), 'wf_3e9a1c7b-5d2')).toEqual({
      workflowName: 'add-tests',
      status: 'completed',
      durationMs: 592950,
      totalTokens: 48210,
      totalToolCalls: 3,
    });
  });

  it('is empty for a run without one', () => {
    expect(workflowSummary(sessionFile(SESSIONS.badge), 'wf_missing')).toEqual({});
  });
});

describe('sessionVersion', () => {
  const copy = mkdtempSync(join(tmpdir(), 'agents-tracer-version-'));
  cpSync(store, copy, { recursive: true });
  afterAll(() => {
    rmSync(copy, { recursive: true, force: true });
  });
  const session = join(copy, `${SESSIONS.badge}.jsonl`);
  const dir = join(copy, SESSIONS.badge);
  const agent = join(dir, 'subagents', 'agent-a1b2c3d4e5f6a7b8c.jsonl');

  it('stays the same while nothing the session reads changes', () => {
    expect(sessionVersion(session)).toBe(sessionVersion(session));
    writeFileSync(join(copy, 'unrelated.txt'), 'x');
    const before = sessionVersion(session);
    utimesSync(join(copy, `${SESSIONS.compaction}.jsonl`), new Date(), new Date());
    expect(sessionVersion(session)).toBe(before);
  });

  it('changes when the transcript, a subagent’s transcript or meta file, or a workflow summary changes', () => {
    const changes = [
      () => {
        appendFileSync(session, '\n');
      },
      () => {
        appendFileSync(agent, '{"type":"user"}\n');
      },
      () => {
        writeFileSync(join(dir, 'subagents', 'agent-a1b2c3d4e5f6a7b8c.meta.json'), '{}');
      },
      () => {
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(dir, 'workflows', 'wf_3e9a1c7b-5d2.json'), later, later);
      },
      () => {
        writeFileSync(join(dir, 'subagents', 'agent-new.jsonl'), '');
      },
    ];
    for (const change of changes) {
      const before = sessionVersion(session);
      change();
      expect(sessionVersion(session)).not.toBe(before);
    }
  });

  it('is a subagent transcript’s own when it is read alone', () => {
    const before = sessionVersion(agent);
    appendFileSync(session, '\n');
    expect(sessionVersion(agent)).toBe(before);
    appendFileSync(agent, '\n');
    expect(sessionVersion(agent)).not.toBe(before);
  });
});

describe('readTranscript', () => {
  it('reads a transcript whose last line was cut off mid-write', () => {
    const t = readTranscript(sessionFile(SESSIONS.compaction));
    expect(t.id).toBe(SESSIONS.compaction);
    expect(t.title).toBe('Cart store reducer');
    expect(t.cwd).toBe('/home/dev/shop');
    expect(t.compactions).toEqual([{ trigger: 'manual', preTokens: 182000, postTokens: 12400, durationMs: 89500 }]);
    expect(t.events.map((e) => e.kind)).toEqual([
      'prompt',
      'response',
      'tool_result',
      'response',
      'compaction_done',
      'command',
      'prompt',
      'response',
      'tool_result',
      'response',
      'prompt',
      'response',
    ]);
  });
});
