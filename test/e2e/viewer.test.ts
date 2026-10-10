import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderHtml } from '../../src/view/index.js';
import { CLAUDE_CODE_STORE as store, SESSIONS } from '../support/fixtures.js';

// The built viewer in Chromium: the page the CLI's html writes for the fixture session, and the
// index the CLI's serve serves. Run with pnpm test:e2e, which builds first.

const cli = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'main.js');
const tmp = mkdtempSync(join(tmpdir(), 'agents-tracer-e2e-'));
const page = join(tmp, 'badge.html');
let browser: Browser;

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error(`no built CLI at ${cli}; run pnpm test:e2e, which builds`);
  execFileSync(process.execPath, [cli, 'html', SESSIONS.badge, '--store', store, '--out', page]);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A page at 1600x1000 in Paris, with the errors it logs. */
async function open(url: string): Promise<{ tab: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Europe/Paris' });
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  tab.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await tab.goto(url);
  await tab.waitForTimeout(300);
  return { tab, errors };
}

/** How many pixels of a canvas are drawn in a color of the given CSS custom property. */
function pixelsOf(tab: Page, canvas: string, property: string): Promise<number> {
  return tab.evaluate(
    ([selector, prop]) => {
      const c = document.querySelector(selector);
      if (!(c instanceof HTMLCanvasElement)) return -1;
      const ctx = c.getContext('2d');
      if (!ctx) return -1;
      const probe = document.createElement('canvas').getContext('2d');
      if (!probe) return -1;
      probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] === r && data[i + 1] === g && data[i + 2] === b) n++;
      return n;
    },
    [canvas, property] as const,
  );
}

/** How many pixels of a canvas are drawn at all. */
function drawnPixels(tab: Page, canvas: string): Promise<number> {
  return tab.evaluate((selector) => {
    const c = document.querySelector(selector);
    const data =
      c instanceof HTMLCanvasElement ? c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data : undefined;
    let n = 0;
    for (let i = 3; i < (data?.length ?? 0); i += 4) if (data?.[i]) n++;
    return n;
  }, canvas);
}

describe('the viewer of a session', () => {
  it('draws the session without errors: the header, the stats, the legend, and the lanes', async () => {
    const { tab, errors } = await open(`file://${page}`);
    expect(await tab.locator('#title').textContent()).toBe('Cart badge in the header');
    expect(await tab.locator('#stats .tile').count()).toBe(8);
    expect(await tab.locator('#legend').textContent()).toContain('Bash');
    expect(await tab.locator('#kind option[value="shell"]').textContent()).toBe('Bash');
    // The model's, the shell's, and other tools' colors on the lanes; the overview drawn too.
    for (const color of ['--series-1', '--series-2', '--series-3'])
      expect(await pixelsOf(tab, '#lanes', color)).toBeGreaterThan(10);
    // The overview's window tints what it covers, so count what is drawn at all.
    expect(await drawnPixels(tab, '#overview')).toBeGreaterThan(10_000);
    expect(await tab.locator('#trace-wrap tr.row').count()).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  it('fills the detail pane when a trace row is clicked, and zooms with W', async () => {
    const { tab, errors } = await open(`file://${page}`);
    const row = tab.locator('#trace-wrap tr.row[data-span]').nth(2);
    const what = (await row.locator('td').nth(3).textContent())?.trim() ?? '';
    await row.click();
    await expect.poll(() => row.getAttribute('class')).toContain('sel');
    expect(await tab.locator('#detail h2').textContent()).toContain(what.split(/\s/)[0]);
    expect(await tab.locator('#detail dl dt').allTextContents()).toEqual(
      expect.arrayContaining(['Started', 'Ended', 'Lane']),
    );
    const before = await tab.locator('#lanes').screenshot();
    await tab.locator('body').press('w');
    await tab.waitForTimeout(200);
    expect((await tab.locator('#lanes').screenshot()).equals(before)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('opens each tab', async () => {
    const { tab, errors } = await open(`file://${page}`);
    for (const [name, text] of [
      ['turns', 'Where it went'],
      ['breakdown', 'Bash by command'],
      ['agents', 'Review the cart badge'],
      ['trace', 'Model response'],
    ] as const) {
      await tab.locator(`.tabs button[data-tab="${name}"]`).click();
      expect(await tab.locator(`#tab-${name}`).isVisible()).toBe(true);
      expect(await tab.locator(`#tab-${name}`).textContent()).toContain(text);
    }
    expect(errors).toEqual([]);
  });

  it('switches the theme, and keeps it', async () => {
    const { tab, errors } = await open(`file://${page}`);
    const theme = tab.locator('#theme');
    expect(await theme.textContent()).toBe('Theme: system');
    await theme.click();
    expect(await theme.textContent()).toBe('Theme: light');
    await theme.click();
    expect(await theme.textContent()).toBe('Theme: dark');
    expect(await tab.evaluate(() => document.documentElement.dataset['theme'])).toBe('dark');
    expect(await tab.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(13, 13, 13)');
    await tab.reload();
    await tab.waitForTimeout(300);
    expect(await theme.textContent()).toBe('Theme: dark');
    expect(await pixelsOf(tab, '#lanes', '--series-1')).toBeGreaterThan(50);
    expect(errors).toEqual([]);
  });
});

describe('the served index', () => {
  let server: ChildProcess;
  let url = '';

  beforeAll(async () => {
    server = spawn(process.execPath, [cli, 'serve', '--store', store, '--port', '0'], {
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

  it('lists the store’s sessions, newest first, and opens one', async () => {
    const { tab, errors } = await open(url);
    expect(await tab.locator('#index-title').textContent()).toBe('Claude Code sessions');
    expect(await tab.locator('#index-table tbody tr td.wide a').allTextContents()).toEqual([
      'Cart badge in the header',
      'Cart store reducer',
      'Add a test for the cart total',
    ]);
    await tab.locator('#index-q').fill('reducer');
    expect(await tab.locator('#index-table tbody tr').count()).toBe(1);
    await tab.locator('#index-table tbody tr td.wide a').click();
    await tab.waitForURL(`${url}s/${SESSIONS.compaction}`);
    await tab.waitForTimeout(300);
    expect(await tab.locator('#title').textContent()).toBe('Cart store reducer');
    expect(await tab.locator('#back').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe('an index of sessions the server cannot all open', () => {
  it('lists a session whose id cannot be in a URL without a link', async () => {
    const template = readFileSync(join(import.meta.dirname, '..', '..', 'dist', 'viewer', 'viewer.html'), 'utf8');
    const t0 = Date.UTC(2026, 0, 5, 9, 0);
    const file = join(tmp, 'index.html');
    writeFileSync(
      file,
      renderHtml(
        {
          index: {
            projectDir: '/home/dev/sessions',
            agent: 'Memory',
            sessions: [
              {
                id: 'aaa111',
                start: t0,
                end: t0 + 60_000,
                size: 2048,
                title: 'Linked',
                first: 'one',
                href: '/s/aaa111',
              },
              { id: 'run.2', start: t0 + 1, end: t0 + 9000, size: 1024, title: 'Unlinked', first: 'two', href: null },
            ],
          },
        },
        template,
      ),
    );
    const { tab, errors } = await open(`file://${file}`);
    expect(await tab.locator('#index-table tbody tr').count()).toBe(2);
    expect(await tab.locator('#index-table tbody tr td.wide a').allTextContents()).toEqual(['Linked']);
    expect(await tab.locator('#index-table tbody tr').first().getAttribute('title')).toMatch(/cannot open/);
    expect(errors).toEqual([]);
  });
});
