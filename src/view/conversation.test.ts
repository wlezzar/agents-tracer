import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeCode } from '../adapters/claude-code/index.js';
import { CONVERSATION, CONVERSATION_STORE } from '../../test/support/fixtures.js';
import { viewConversation } from './conversation.js';

const session = claudeCode.load(join(CONVERSATION_STORE, `${CONVERSATION.session}.jsonl`), { conversation: true });

describe('the conversation page’s data', () => {
  it('holds the conversation, its build time, and the server’s links', () => {
    expect(viewConversation(session, { now: 5 })).toMatchObject({ generated: 5, conversation: { shellLabel: 'Bash' } });
    expect(viewConversation(session, { serve: true, timelineHref: '/s/7a3c' })).toMatchObject({
      serve: true,
      timelineHref: '/s/7a3c',
    });
    expect(Object.keys(viewConversation(session))).toEqual(['conversation', 'generated']);
  });

  it('clips every text to its head and tail', () => {
    const page = JSON.stringify(viewConversation(session, { maxText: 12 }));
    expect(page).toContain('characters left out');
    expect(page).not.toContain('Make the checkout button disabled while the order is submitting');
    expect(JSON.stringify(viewConversation(session))).toContain(
      'Make the checkout button disabled while the order is submitting',
    );
  });
});
