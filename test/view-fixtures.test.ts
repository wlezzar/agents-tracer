import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isRecord } from '../src/util/index.js';
import { runCli } from './support/cli.js';
import { CLAUDE_CODE_STORE, FIXTURES } from './support/fixtures.js';

// The view data the CLI's html embeds for each fixture transcript holds every field of the
// prototype's, with the same values (fields may be added). scripts/expectations.ts wrote the
// prototype's into expected/view/, without `generated` and with `session.file` relative to the store.

const views = join(FIXTURES, 'claude-code', 'expected', 'view');
const transcripts = {
  badge: '5e1f',
  'old-format': '5e9b',
  compaction: 'c3d4',
  'agent-review': 'a1b2',
  'agent-nested': 'a9f8',
  'agent-plan': 'ab12',
  'agent-write': 'ac98',
};

const tmp = mkdtempSync(join(tmpdir(), 'agents-tracer-view-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The view data embedded in a page the CLI wrote, as the expectations hold it. */
function embedded(file: string): Record<string, unknown> {
  const json = /<script id="trace-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
    readFileSync(file, 'utf8'),
  )?.[1];
  const data: unknown = JSON.parse(json ?? 'null');
  if (!isRecord(data) || !isRecord(data['session'])) throw new Error(`${file} embeds no view data`);
  const { generated, session, ...rest } = data;
  expect(typeof generated).toBe('number');
  return { ...rest, session: { ...session, file: relative(CLAUDE_CODE_STORE, String(session['file'])) } };
}

describe('the view data over the fixtures', () => {
  it.each(Object.entries(transcripts))('agents-tracer html %s holds the prototype’s view data', async (name, ref) => {
    const out = join(tmp, `${name}.html`);
    const result = await runCli(['html', ref, '--store', CLAUDE_CODE_STORE, '--out', out]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const expected: unknown = JSON.parse(readFileSync(join(views, `${name}.json`), 'utf8'));
    expect(embedded(out)).toMatchObject(isRecord(expected) ? expected : {});
  });
});
