import { describe, expect, it } from 'vitest';

import type { Adapter } from '../model/index.js';
import { claudeCode } from './claude-code/index.js';
import { createRegistry, registry } from './registry.js';

const fake = (id: string): Adapter => ({
  id,
  displayName: `Fake ${id}`,
  defaultStore: (cwd, home) => `${home}/.fake/${cwd}`,
  listSessions: () => [],
  resolve: (_store, ref) => ref,
  load: () => {
    throw new Error('not loaded in these tests');
  },
});

describe('createRegistry', () => {
  it('finds adapters by id, in the order given', () => {
    const a = fake('a');
    const b = fake('b');
    const registry = createRegistry([a, b], 'b');
    expect(registry.adapters).toEqual([a, b]);
    expect(registry.defaultId).toBe('b');
    expect(registry.find('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
    expect(registry.find('c')).toBeUndefined();
  });

  it('names the known ids when an id is unknown', () => {
    const registry = createRegistry([fake('a'), fake('b')], 'a');
    expect(() => registry.get('c')).toThrow('unknown adapter "c"; known: a, b');
  });

  it('refuses two adapters with one id, and a default no adapter has', () => {
    expect(() => createRegistry([fake('a'), fake('a')], 'a')).toThrow('two adapters have the id "a"');
    expect(() => createRegistry([fake('a')], 'b')).toThrow('no adapter has the default id "b"');
  });
});

describe('registry', () => {
  it('ships the Claude Code adapter as the default', () => {
    expect(registry.defaultId).toBe('claude-code');
    expect(registry.adapters.map((a) => a.id)).toContain('claude-code');
    expect(registry.get('claude-code')).toBe(claudeCode);
  });
});
