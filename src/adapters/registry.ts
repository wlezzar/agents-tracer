import type { Adapter, AdapterRegistry } from '../model/index.js';
import { CLAUDE_CODE_ID, claudeCode } from './claude-code/index.js';

/**
 * A registry of `adapters`, whose default is `defaultId`. Throws when two adapters share an id or
 * when no adapter has the default id.
 */
export function createRegistry(adapters: readonly Adapter[], defaultId: string): AdapterRegistry {
  const byId = new Map<string, Adapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) throw new Error(`two adapters have the id "${adapter.id}"`);
    byId.set(adapter.id, adapter);
  }
  if (!byId.has(defaultId)) throw new Error(`no adapter has the default id "${defaultId}"`);
  const list = [...adapters];
  return {
    adapters: list,
    defaultId,
    find: (id) => byId.get(id),
    get: (id) => {
      const adapter = byId.get(id);
      if (!adapter) throw new Error(`unknown adapter "${id}"; known: ${list.map((a) => a.id).join(', ')}`);
      return adapter;
    },
  };
}

/** The shipped adapters, which the CLI and the server use; Claude Code is the default. */
export const registry: AdapterRegistry = createRegistry([claudeCode], CLAUDE_CODE_ID);
