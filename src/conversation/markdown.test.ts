import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeCode } from '../adapters/claude-code/index.js';
import { CONVERSATION, CONVERSATION_STORE } from '../../test/support/fixtures.js';
import { sessionConversation } from './build.js';
import { fence, markdown, quote } from './markdown.js';

const conversation = sessionConversation(
  claudeCode.load(join(CONVERSATION_STORE, `${CONVERSATION.session}.jsonl`), { conversation: true }),
);

describe('the Markdown export', () => {
  it('heads the session with its numbers', () => {
    const md = markdown(conversation);
    expect(md.split('\n').slice(0, 9)).toEqual([
      '# Checkout button state',
      '',
      `- Session: \`${CONVERSATION.session}\``,
      '- Directory: `/home/dev/shop`',
      '- Time: 2026-01-05 10:00 → 2026-01-05 10:06',
      '- Wall 6m04s · active 3m14s (model 44s, tools 1m34s, you 1m51s)',
      '- 9 model calls · 4 tool calls (2 failed or interrupted, 1 refused) · peak context 19.8k tokens · 435 output tokens · 1 compaction',
      '- Harness context: 7 items, ~135 tokens (estimated at four characters a token)',
      '- 1 agent',
    ]);
  });

  it('writes each turn: the prompt quoted, the model’s calls with their context, the tools fenced', () => {
    const md = markdown(conversation);
    expect(md).toContain(
      '### Turn 1 · you · 10:00:01 · active 2m04s\n\n#### You · 10:00:01 · 1 image\n\n> Make the checkout button disabled',
    );
    expect(md).toContain('#### Model · claude-opus-4-1 · 10:00:12 · 5.5s · context 17.6k (+600) · 80 out');
    expect(md).toContain('*Thinking (0.9s), redacted.*');
    expect(md).toContain(
      '##### Bash · Run the checkout tests · `pnpm test` · 18s · failed · you allowed it\n\n```sh\npnpm test -- Checkout\n```',
    );
    expect(md).toContain('· refused (permission-rule)');
    expect(md).toContain('#### Model · <synthetic> · 10:03:05 · 5.0s · stop: stop_sequence · API error');
    expect(md).toContain('#### Compaction · 10:04:00 · auto · 19.8k → 4.1k tokens');
    expect(md).toContain('#### Task report · 10:05:00\n\nSummary: The watch build finished');
    expect(md).toContain('> **warning** · 10:05:10 · Request interrupted by user');
    expect(md.endsWith('> The button needs aria-busy while submitting.\n')).toBe(true);
  });

  it('lists what the harness added, one line each, or in full with context', () => {
    expect(markdown(conversation)).toContain(
      '#### Harness · 3 items · ~48 tokens\n\n- reminder: System reminder (~15 tokens)\n- memory: Memory · src/AGENTS.md (~17 tokens)\n',
    );
    const full = markdown(conversation, { context: true });
    expect(full).toContain(
      '**memory: Memory · src/AGENTS.md** (~17 tokens)\n\n```\nContents of /home/dev/shop/src/AGENTS.md:',
    );
  });

  it('writes the agents after the main thread, linked from the calls that launched them', () => {
    const md = markdown(conversation);
    expect(md).toContain(`Its conversation: Agent: Check the form's accessibility (\`${CONVERSATION.agent}\`).`);
    expect(md).toContain(
      `## Agent: Check the form's accessibility (\`${CONVERSATION.agent}\`)\n\nreviewer · 10:00:46 → 10:01:58`,
    );
    expect(md).toContain('Launched by tool call `toolu_c04` of the main session.');
    expect(md).toContain('#### Prompt · 10:00:46');
    expect(markdown(conversation, { subagents: false })).not.toContain('## Agent:');
  });

  it('writes one turn, with the agents it launched', () => {
    const one = markdown(conversation, { turn: 1 });
    expect(one).toContain('### Turn 1 ·');
    expect(one).not.toContain('### Turn 2 ·');
    expect(one).toContain('## Agent:');
    expect(markdown(conversation, { turn: 2 })).not.toContain('## Agent:');
  });

  it('keeps the head and tail of a long output, or all of it', () => {
    const md = markdown(conversation, { maxOutput: 20 });
    expect(md).toContain('Exit code \n\n… 61 characters left out …\n\nsubmitting');
    expect(markdown(conversation, { maxOutput: 0 })).not.toContain('characters left out');
  });
});

describe('fence and quote', () => {
  it('fences a text with more backticks than it holds', () => {
    expect(fence('a\n')).toBe('```\na\n```');
    expect(fence('x ``` y', 'sh')).toBe('````sh\nx ``` y\n````');
  });

  it('quotes every line', () => {
    expect(quote('a\n\n# b\n')).toBe('> a\n>\n> # b');
  });
});
