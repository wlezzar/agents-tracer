import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLAUDE_CODE_STORE, CONVERSATION, CONVERSATION_STORE, SESSIONS } from '../support/fixtures.js';

// The conversation page in Chromium: the page html --conversation writes for the conversation
// fixture, and the pages serve links together. Run with pnpm test:e2e, which builds first.

const cli = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'main.js');
const tmp = mkdtempSync(join(tmpdir(), 'agents-tracer-e2e-conversation-'));
const page = join(tmp, 'conversation.html');
let browser: Browser;

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error(`no built CLI at ${cli}; run pnpm test:e2e, which builds`);
  execFileSync(process.execPath, [
    cli,
    'html',
    CONVERSATION.session,
    '--store',
    CONVERSATION_STORE,
    '--conversation',
    '--out',
    page,
  ]);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A page at 1500x1000 in Paris, with the errors it logs. */
async function open(url: string): Promise<{ tab: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, timezoneId: 'Europe/Paris' });
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  tab.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await tab.goto(url);
  await tab.waitForSelector('.cv-turn');
  return { tab, errors };
}

describe('the conversation page', () => {
  it('shows the main thread turn by turn, with its stats, its outline, and the context chart', async () => {
    const { tab, errors } = await open(`file://${page}`);
    expect(await tab.locator('#cv-title').textContent()).toBe('Checkout button state');
    expect(await tab.locator('#cv-back').isVisible()).toBe(false);
    expect(await tab.locator('#cv-timeline').isVisible()).toBe(false);
    expect(await tab.locator('.cv-turn-head h2').allTextContents()).toEqual([
      'Before the first prompt',
      'Turn 1',
      'Turn 2',
      'Turn 3',
      'Turn 4',
    ]);
    expect(await tab.locator('#cv-outline a').count()).toBe(5);
    expect(await tab.locator('#cv-outline a').nth(3).textContent()).toContain('The watch build finished');
    expect(await tab.locator('#cv-stats .tile .v').allTextContents()).toContain('19.8k');
    expect(await tab.locator('#cv-chart svg polyline').count()).toBe(1);
    expect(await tab.locator('#cv-chart .cv-compaction-mark').count()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('opens a tool call to show its input and output, built when it opens', async () => {
    const { tab } = await open(`file://${page}`);
    const row = tab.locator('[data-tool="toolu_c02"]');
    expect(await row.locator('.cv-open').isHidden()).toBe(true);
    expect(await row.locator('pre').count()).toBe(0);
    await row.locator('.cv-row').click();
    expect(await row.locator('pre').allTextContents()).toEqual([
      'pnpm test -- Checkout',
      'Exit code 1\n FAIL  src/Checkout.test.tsx\n  ✕ disables the button while submitting',
    ]);
    expect(await row.locator('.cv-facts').textContent()).toContain('allowed · by you');
    await row.locator('.cv-row').press('Enter');
    expect(await row.locator('.cv-open').isHidden()).toBe(true);
  });

  it('filters to failures, searches with marks, and hides the harness’s context', async () => {
    const { tab } = await open(`file://${page}`);
    await tab.selectOption('#cv-filter', 'failed');
    expect(
      await tab.locator('#cv-stream [data-tool]').evaluateAll((n) => n.map((x) => x.getAttribute('data-tool'))),
    ).toEqual(['toolu_c02', 'toolu_c03']);
    await tab.selectOption('#cv-filter', 'all');
    await tab.locator('#cv-q').fill('aria-busy');
    await tab.waitForTimeout(400);
    expect(await tab.locator('#cv-stream mark').count()).toBeGreaterThan(1);
    expect(await tab.locator('#cv-count').textContent()).toBe('1 of 5 turns match');
    await tab.locator('#cv-q').fill('');
    await tab.waitForTimeout(400);
    expect(await tab.locator('.cv-harness').count()).toBe(5);
    await tab.locator('#cv-harness').uncheck();
    expect(await tab.locator('.cv-harness').count()).toBe(0);
  });

  it('goes to an agent’s conversation and back to the call that launched it', async () => {
    const { tab, errors } = await open(`file://${page}`);
    await tab.locator('[data-tool="toolu_c04"] .cv-row').click();
    await tab.getByRole('button', { name: /Show the agent's conversation/ }).click();
    expect(await tab.locator('#cv-thread').inputValue()).toBe(CONVERSATION.agent);
    expect(tab.url()).toContain(`#lane=${CONVERSATION.agent}`);
    expect(await tab.locator('.cv-prompt .who').first().textContent()).toBe('Prompt');
    await tab.locator('#cv-launch a').click();
    expect(await tab.locator('#cv-thread').inputValue()).toBe('main');
    expect(await tab.locator('[data-tool="toolu_c04"]').evaluate((n) => n.classList.contains('open'))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('opens at the call its hash points at, clearing a filter that hides it', async () => {
    const { tab } = await open(`file://${page}#lane=main&tool=toolu_c01`);
    expect(await tab.locator('[data-tool="toolu_c01"]').evaluate((n) => n.classList.contains('open'))).toBe(true);
    await tab.selectOption('#cv-filter', 'shell');
    expect(await tab.locator('[data-tool="toolu_c04"]').count()).toBe(0);
    await tab.evaluate(() => {
      location.hash = '#lane=main&tool=toolu_c04';
    });
    await tab.waitForTimeout(200);
    expect(await tab.locator('#cv-filter').inputValue()).toBe('all');
    expect(await tab.locator('[data-tool="toolu_c04"]').evaluate((n) => n.classList.contains('open'))).toBe(true);
  });

  it('steps through the turns and the failures with the keyboard', async () => {
    const { tab } = await open(`file://${page}`);
    await tab.keyboard.press('j');
    await tab.keyboard.press('j');
    await tab.waitForTimeout(100);
    const top = await tab.locator('#cv-turn-1').evaluate((n) => Math.round(n.getBoundingClientRect().top));
    expect(Math.abs(top)).toBeLessThan(10);
    await tab.keyboard.press('f');
    await tab.waitForTimeout(100);
    expect(await tab.locator('.cv-flash').getAttribute('data-tool')).toBe('toolu_c02');
    await tab.keyboard.press('/');
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe('cv-q');
  });
});

describe('the served pages', () => {
  let server: ChildProcess;
  let url = '';

  beforeAll(async () => {
    server = spawn(process.execPath, [cli, 'serve', '--store', CLAUDE_CODE_STORE, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const { stdout } = server;
    if (!stdout) throw new Error('the server has no output');
    for await (const line of createInterface({ input: stdout })) {
      const found = /^Serving .* on (http:\/\/127\.0\.0\.1:\d+\/)$/.exec(line)?.[1];
      if (found) {
        url = found;
        break;
      }
    }
  });
  afterAll(() => {
    server.kill();
  });

  it('link the index, the conversation, and the timeline, call to call', async () => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, timezoneId: 'Europe/Paris' });
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(String(e)));
    await tab.goto(url);
    await tab.locator('#index-table tbody tr').first().getByRole('link', { name: 'Conversation' }).click();
    await tab.waitForURL(`${url}s/${SESSIONS.badge}/conversation#lane=main`);
    await tab.waitForSelector('.cv-turn');
    expect(await tab.locator('#cv-back').isVisible()).toBe(true);

    // From a tool call to its span in the timeline.
    const row = tab.locator('[data-tool]').first();
    const id = await row.getAttribute('data-tool');
    await row.locator('.cv-row').click();
    await row.getByRole('link', { name: 'Show in the timeline' }).click();
    await tab.waitForURL(`${url}s/${SESSIONS.badge}#lane=main&tool=${id ?? ''}`);
    await tab.waitForTimeout(300);
    expect(await tab.locator('#detail h2').textContent()).toContain('Read');

    // And back.
    await tab.getByRole('link', { name: 'Show in the conversation' }).click();
    await tab.waitForURL(`${url}s/${SESSIONS.badge}/conversation#lane=main&tool=${id ?? ''}`);
    await tab.waitForSelector('.cv-turn');
    expect(await tab.locator(`[data-tool="${id ?? ''}"]`).evaluate((n) => n.classList.contains('open'))).toBe(true);
    expect(await tab.locator('#cv-timeline').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });
});
