import { describe, expect, it } from 'vitest';

import { bucketLabel, catOfBucket, catOfSpan, cats, failed, spanDetail, spanName } from './categories.js';
import { modelSpan, toolSpan } from '../../../test/support/view-data.js';

describe('the viewer’s categories', () => {
  const categories = { sh: 'shell', ask: 'question', Read: 'file' } as const;

  it('colors a bucket by its tool’s category, and each kind of waiting apart', () => {
    expect(
      [
        'model',
        'compaction',
        'tool:sh',
        'tool:Read',
        'tool:?',
        'tool:unknown',
        'you: answering questions',
        'idle: waiting on you',
        'idle: waiting on you, background tasks running',
        'idle: waiting on a background task',
      ].map((b) => catOfBucket(b, categories)),
    ).toEqual(['model', 'model', 'shell', 'tool', 'tool', 'tool', 'you', 'you', 'youbg', 'bg']);
    expect(catOfBucket('tool:__proto__', categories)).toBe('tool');
  });

  it('colors a span: the model, the shell, the person for a question, else other tools', () => {
    expect(
      [modelSpan(0, 1), toolSpan(0, 1, { cat: 'shell' }), toolSpan(0, 1, { cat: 'question' }), toolSpan(0, 1)].map(
        catOfSpan,
      ),
    ).toEqual(['model', 'shell', 'you', 'tool']);
  });

  it('labels the legend’s shell with the agent’s shell tool', () => {
    expect(cats('sh').map((c) => c.label)).toEqual([
      'Model',
      'sh',
      'Other tools',
      'Waiting on you',
      'Waiting on you, background tasks running',
      'Waiting on a background task',
    ]);
  });

  it('names buckets and spans', () => {
    expect(
      ['model', 'compaction', 'tool:sh', 'you: answering questions', 'idle: waiting on a background task', 'other'].map(
        bucketLabel,
      ),
    ).toEqual([
      'Model',
      'Compaction (model)',
      'sh',
      'You, answering questions',
      'Waiting on a background task',
      'other',
    ]);
    expect(spanName(modelSpan(0, 1))).toBe('Model response');
    expect(spanName(toolSpan(0, 1, { name: 'sh' }))).toBe('sh');
    expect(spanDetail(modelSpan(0, 1, { sum: 'thinking' }))).toBe('thinking');
    expect(spanDetail(toolSpan(0, 1, { pv: 'make' }))).toBe('make');
  });

  it('counts a tool call failed when it errored or was interrupted', () => {
    expect(
      [toolSpan(0, 1), toolSpan(0, 1, { err: true }), toolSpan(0, 1, { intr: true }), modelSpan(0, 1)].map(failed),
    ).toEqual([false, true, true, false]);
  });
});
