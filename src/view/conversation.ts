import { analyzeSession } from '../analysis/index.js';
import {
  buildConversation,
  type Conversation,
  type ConversationBlock,
  type ConversationItem,
} from '../conversation/index.js';
import type { Session } from '../model/index.js';
import { clip } from '../util/index.js';
import type { ConversationData } from './types.js';

// The conversation page's data: the session's conversation, its texts clipped so that one huge
// output cannot swell the page, and the links the server gives it.

/** The most characters of a text the conversation page holds; a longer one keeps its head and tail. */
export const CONVERSATION_TEXT = 100_000;

/** How to build the conversation page's data. */
export interface ConversationViewOptions {
  /** The page is served, so it links back to the index. */
  readonly serve?: boolean;
  /** Where the session's timeline is, which the page links to; the server's only. */
  readonly timelineHref?: string;
  /** The build time, epoch milliseconds; now by default. */
  readonly now?: number;
  /** The most characters of each text; {@link CONVERSATION_TEXT} by default. */
  readonly maxText?: number;
}

function clipBlock(b: ConversationBlock, n: number): ConversationBlock {
  switch (b.type) {
    case 'tool':
      return { ...b, input: clip(b.input, n), output: clip(b.output, n) };
    case 'thinking':
    case 'text':
    case 'other':
      return { ...b, text: clip(b.text, n) };
  }
}

function clipItem(item: ConversationItem, n: number): ConversationItem {
  switch (item.type) {
    case 'model':
      return { ...item, blocks: item.blocks.map((b) => clipBlock(b, n)) };
    case 'prompt':
    case 'context':
    case 'notice':
      return { ...item, text: clip(item.text, n) };
    case 'compaction':
      return { ...item, summary: clip(item.summary, n) };
    case 'result':
      return { ...item, output: clip(item.output, n) };
  }
}

/** The conversation page's data for a conversation. */
export function conversationView(conversation: Conversation, options: ConversationViewOptions = {}): ConversationData {
  const n = options.maxText ?? CONVERSATION_TEXT;
  return {
    conversation: {
      ...conversation,
      shapes: conversation.shapes.map((s) => ({
        ...s,
        system: s.system.map((b) => ({ ...b, text: clip(b.text, n) })),
        tools: s.tools.map((d) => ({ ...d, description: clip(d.description, n), schema: clip(d.schema, n) })),
      })),
      threads: conversation.threads.map((t) => ({
        ...t,
        turns: t.turns.map((turn) => ({ ...turn, items: turn.items.map((i) => clipItem(i, n)) })),
      })),
    },
    generated: options.now ?? Date.now(),
    ...(options.serve === true && { serve: true }),
    ...(options.timelineHref !== undefined && { timelineHref: options.timelineHref }),
  };
}

/**
 * The conversation page's data for a session loaded with its conversation (`LoadOptions.conversation`);
 * for one loaded without, what its events say.
 */
export function viewConversation(session: Session, options: ConversationViewOptions = {}): ConversationData {
  return conversationView(buildConversation(analyzeSession(session)), options);
}
