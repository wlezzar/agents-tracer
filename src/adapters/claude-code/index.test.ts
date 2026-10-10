import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_STORE as store, SESSIONS, sessionFile } from '../../../test/support/fixtures.js';
import { claudeCode } from './index.js';

describe('the Claude Code adapter', () => {
  it('names itself and its default store', () => {
    expect(claudeCode.id).toBe('claude-code');
    expect(claudeCode.displayName).toBe('Claude Code');
    expect(claudeCode.defaultStore('/home/dev/shop', '/home/dev')).toBe('/home/dev/.claude/projects/-home-dev-shop');
  });

  it('loads a session with its subagents and workflow runs', () => {
    const session = claudeCode.load(claudeCode.resolve(store, '5e1f'));
    expect(session.adapter).toBe('claude-code');
    expect(session.shellToolName).toBe('Bash');
    expect(session.main.id).toBe(SESSIONS.badge);
    expect(session.main.title).toBe('Cart badge in the header');
    const agents = [...session.agents].sort((a, b) => a.id.localeCompare(b.id));
    expect(agents.map(({ transcript, ...agent }) => ({ ...agent, transcript: transcript.id }))).toEqual([
      {
        id: 'a1b2c3d4e5f6a7b8c',
        transcript: 'agent-a1b2c3d4e5f6a7b8c',
        description: 'Review the cart badge',
        agentType: 'general-purpose',
        background: true,
        group: null,
      },
      {
        id: 'a9f8e7d6c5b4a3921',
        transcript: 'agent-a9f8e7d6c5b4a3921',
        description: 'Check the badge styles',
        agentType: 'Explore',
        background: true,
        group: null,
      },
      {
        id: 'ab12cd34ef56ab78c',
        transcript: 'agent-ab12cd34ef56ab78c',
        description: 'Plan tests for CartBadge',
        phase: 'plan',
        agentType: 'workflow-subagent',
        background: false,
        group: 'wf_3e9a1c7b-5d2',
      },
      {
        id: 'ac98ba76dc54fe32a',
        transcript: 'agent-ac98ba76dc54fe32a',
        description: 'Write tests for CartBadge',
        phase: 'write',
        agentType: 'workflow-subagent',
        background: false,
        group: 'wf_3e9a1c7b-5d2',
      },
    ]);
    expect(session.groups).toEqual([
      {
        id: 'wf_3e9a1c7b-5d2',
        kind: 'Workflow',
        label: 'Workflow add-tests',
        name: 'add-tests',
        status: 'completed',
        durationMs: 592950,
        totalTokens: 48210,
        totalToolCalls: 3,
      },
    ]);
  });

  it('describes the tool calls it loads', () => {
    const { main } = claudeCode.load(sessionFile(SESSIONS.badge));
    const calls = main.events.flatMap((e) => (e.kind === 'response' ? e.toolCalls : []));
    expect(calls.map((c) => [c.name, c.desc.category, c.desc.preview])).toEqual([
      ['Read', 'file', 'src/components/Header.tsx'],
      ['Grep', 'search', 'cartCount'],
      ['Edit', 'file', 'src/components/Header.tsx'],
      ['Bash', 'shell', 'Run the header tests · pnpm test'],
      ['AskUserQuestion', 'question', 'Should the badge hide when the cart is empty?'],
      ['Write', 'file', 'src/components/CartBadge.tsx'],
      ['Bash', 'shell', 'Start the dev server · pnpm dev  [background]'],
      ['Bash', 'shell', 'Run the header tests again · pnpm test'],
      ['Read', 'file', 'docs/badge-mock.png'],
      ['Bash', 'shell', 'Run the e2e tests · pnpm exec playwright'],
      ['TaskStop', 'task-control', '{"task_id":"bk3m9x"}'],
      ['Agent', 'agent', 'Review the cart badge (general-purpose)'],
      ['Bash', 'shell', 'Build the app · pnpm build  [background]'],
      ['Bash', 'shell', 'Lint the app · pnpm lint'],
      ['Edit', 'file', 'src/components/CartBadge.tsx'],
      ['Workflow', 'workflow', 'add-tests'],
    ]);
  });

  it('loads a subagent transcript on its own, without agents', () => {
    const file = join(store, SESSIONS.badge, 'subagents', 'agent-a1b2c3d4e5f6a7b8c.jsonl');
    const session = claudeCode.load(claudeCode.resolve(store, 'a1b2'));
    expect(session.main.path).toBe(file);
    expect(session.main.id).toBe('agent-a1b2c3d4e5f6a7b8c');
    expect(session.agents).toEqual([]);
    expect(session.groups).toEqual([]);
  });

  it('loads a session without subagents', () => {
    const session = claudeCode.load(sessionFile(SESSIONS.oldFormat));
    expect(session.agents).toEqual([]);
    expect(session.groups).toEqual([]);
    expect(session.main.title).toBeUndefined();
  });
});
