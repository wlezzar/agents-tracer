import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isRecord } from '../src/util/index.js';
import { runCli } from './support/cli.js';
import { CLAUDE_CODE_STORE, FIXTURES } from './support/fixtures.js';

// The CLI's report and list over the synthetic Claude Code store print, byte for byte, what the
// prototype prints for the same files and flags. scripts/expectations.ts wrote the expected
// outputs by running the prototype; rerun it when a fixture or a case changes.

const expected = join(FIXTURES, 'claude-code', 'expected');

function casesOf(file: string): { file: string; command: string[] }[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} holds no list of cases`);
  return parsed.map((c: unknown) => {
    if (!isRecord(c) || typeof c['file'] !== 'string' || !Array.isArray(c['command']))
      throw new Error(`${file} holds a malformed case`);
    return { file: c['file'], command: c['command'].map(String) };
  });
}

const cases = casesOf(join(expected, 'cases.json'));

describe('the report and the list over the fixtures', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases.map((c) => [c.command.join(' '), c] as const))('agents-tracer %s', async (_, c) => {
    const result = await runCli([...c.command, '--store', CLAUDE_CODE_STORE]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(readFileSync(join(expected, c.file), 'utf8'));
  });
});
