import { describe, expect, it } from 'vitest';

import { parseTarget, targetHash } from './links.js';

describe('links between the timeline and the conversation', () => {
  it('names a lane and a call in the hash, and reads it back', () => {
    for (const target of [{ lane: 'main' }, { lane: 'main', tool: 'toolu_01' }, { lane: 'a1b2', model: 'msg_01' }]) {
      expect(parseTarget(targetHash(target))).toEqual(target);
    }
    expect(targetHash({ lane: 'main', tool: 'a&b' })).toBe('#lane=main&tool=a%26b');
  });

  it('reads nothing from a hash that names no lane', () => {
    expect(parseTarget('')).toBeNull();
    expect(parseTarget('#tool=toolu_01')).toBeNull();
    expect(parseTarget('#lane=')).toBeNull();
  });
});
