import { describe, expect, it } from 'vitest';

import { conversationTurn, modelItem, toolBlock } from '../../../test/support/view-data.js';
import type { ContextItem, PromptItem } from '../../view/types.js';
import {
  blockShown,
  isFailure,
  itemShown,
  matches,
  showsAll,
  turnShown,
  turnTools,
  type FilterState,
} from './conversationFilter.js';

const all: FilterState = { filter: 'all', query: '', harness: true };
const prompt: PromptItem = {
  type: 'prompt',
  ts: 0,
  by: 'you',
  text: 'Fix the cart',
  origin: null,
  summary: null,
  images: 0,
};
const context: ContextItem = {
  type: 'context',
  ts: 0,
  source: 'reminder',
  label: 'Token budget',
  text: '15000 tokens used',
  tokens: 5,
};
const shell = toolBlock('t1', {
  name: 'Shell',
  category: 'shell',
  input: 'pnpm test',
  output: 'FAIL cart',
  status: 'error',
  ms: 12_000,
});
const read = toolBlock('t2', { input: 'src/cart.ts', output: 'export const cart = 1;' });
const text = { type: 'text', text: 'The test fails on the cart total.' } as const;
const thinking = { type: 'thinking', text: 'Look at the reducer.', redacted: false, ms: null } as const;
const unrecorded = { type: 'thinking', text: '', redacted: false, ms: 900 } as const;
const model = modelItem('m1', [thinking, unrecorded, text, shell, read]);

describe('what the conversation page shows', () => {
  it('shows everything, the harness’s context included unless it is hidden', () => {
    expect(itemShown(prompt, all)).toBe(true);
    expect(itemShown(context, all)).toBe(true);
    expect(itemShown(context, { ...all, harness: false })).toBe(false);
    expect(model.blocks.every((b) => blockShown(b, model, all))).toBe(true);
    expect(showsAll(all)).toBe(true);
    expect(showsAll({ ...all, harness: false })).toBe(false);
  });

  it('filters by what a part is', () => {
    const shown = (filter: FilterState['filter']) =>
      model.blocks
        .filter((b) => blockShown(b, model, { ...all, filter }))
        .map((b) => (b.type === 'tool' ? b.id : b.type));
    expect(shown('dialogue')).toEqual(['text']);
    expect(shown('tools')).toEqual(['t1', 't2']);
    expect(shown('shell')).toEqual(['t1']);
    expect(shown('failed')).toEqual(['t1']);
    expect(shown('thinking')).toEqual(['thinking']);
    expect(shown('slow')).toEqual(['t1']);
    expect(shown('harness')).toEqual([]);
    expect(itemShown(prompt, { ...all, filter: 'dialogue' })).toBe(true);
    expect(itemShown(prompt, { ...all, filter: 'tools' })).toBe(false);
    expect(itemShown(context, { ...all, filter: 'harness', harness: false })).toBe(true);
  });

  it('searches every part’s text, a tool call’s output included', () => {
    const search = (query: string) =>
      model.blocks
        .filter((b) => blockShown(b, model, { ...all, query }))
        .map((b) => (b.type === 'tool' ? b.id : b.type));
    expect(search('cart')).toEqual(['text', 't1', 't2']);
    expect(search('reducer')).toEqual(['thinking']);
    expect(itemShown(context, { ...all, query: 'tokens used' })).toBe(true);
    expect(itemShown(prompt, { ...all, query: 'nothing' })).toBe(false);
  });

  it('shows a model call, and a turn, when any of its parts is shown', () => {
    const turn = conversationTurn(1, [prompt, model]);
    expect(itemShown(model, { ...all, filter: 'shell' })).toBe(true);
    expect(itemShown(modelItem('m2', [read]), { ...all, filter: 'shell' })).toBe(false);
    expect(turnShown(turn, { ...all, query: 'reducer' })).toBe(true);
    expect(turnShown(turn, { ...all, query: 'nowhere' })).toBe(false);
  });

  it('counts a turn’s tool calls and its failures, a refused call among them', () => {
    const refused = toolBlock('t3', { permission: { allowed: false, by: 'rule' } });
    expect(isFailure(refused)).toBe(true);
    expect(isFailure(read)).toBe(false);
    expect(turnTools(conversationTurn(1, [prompt, model, modelItem('m3', [refused])]))).toEqual({
      calls: 3,
      failures: 2,
    });
  });

  it('finds where a search occurs, case aside', () => {
    expect(matches('Cart cart CART', 'cart')).toEqual([
      [0, 4],
      [5, 9],
      [10, 14],
    ]);
    expect(matches('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(matches('text', '')).toEqual([]);
    expect(matches('x'.repeat(10), 'x', 3)).toHaveLength(3);
  });
});
