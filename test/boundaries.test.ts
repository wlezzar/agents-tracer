import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { boundaries } from '../eslint/boundaries.mjs';
import { TOOL_NAMES } from '../src/adapters/claude-code/tools.js';
import { registry } from '../src/adapters/registry.js';

// The adapter boundary (eslint/boundaries.mjs) for the files of src/ that ESLint does not read, such
// as the viewer's template: outside the adapters' directories, no file names an agent's tools, files,
// or records. ESLint checks the TypeScript files (eslint.config.mjs). And every adapter has its
// entry, which names every tool it knows.

const src = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** True for a file in an adapter's directory, src/adapters/<id>/. */
const inAdapter = (rel: string): boolean => rel.startsWith(`adapters${sep}`) && rel.split(sep).length > 2;

describe('the adapter boundary', () => {
  const others = files(src)
    .map((path) => relative(src, path))
    .filter((rel) => !inAdapter(rel) && !rel.endsWith('.ts'));

  it.each(others)('src/%s names no agent’s tools, files, or records', (rel) => {
    const lines = readFileSync(join(src, rel), 'utf8').split('\n');
    const hits = Object.values(boundaries).flatMap(({ agent, words }) =>
      lines.flatMap((line, i) => (words.test(line) ? [`${agent}, line ${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  it('has an entry for every shipped adapter', () => {
    expect(registry.adapters.map((a) => a.id).filter((id) => !Object.hasOwn(boundaries, id))).toEqual([]);
  });

  it('names every tool Claude Code describes by category', () => {
    expect([...(boundaries['claude-code']?.tools ?? [])].sort()).toEqual([...TOOL_NAMES].sort());
  });
});
