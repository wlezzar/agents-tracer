import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { copyProjects, PROJECTS, SESSIONS } from '../support/fixtures.js';

// The projects page serve --all serves, in Chromium, for a home whose Claude Code root holds copies
// of the fixture stores. Run with pnpm test:e2e, which builds first.

const cli = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'main.js');
const home = mkdtempSync(join(tmpdir(), 'agents-tracer-e2e-projects-'));
let browser: Browser;
let server: ChildProcess;
let url = '';

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error(`no built CLI at ${cli}; run pnpm test:e2e, which builds`);
  copyProjects(join(home, '.claude', 'projects'));
  server = spawn(process.execPath, [cli, 'serve', '--all', '--port', '0'], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const { stdout } = server;
  if (!stdout) throw new Error('the server has no output');
  for await (const line of createInterface({ input: stdout })) {
    const found = /^Serving every project in .* on (http:\/\/127\.0\.0\.1:\d+\/)$/.exec(line)?.[1];
    if (found) {
      url = found;
      break;
    }
  }
  browser = await chromium.launch();
});
afterAll(async () => {
  server.kill();
  await browser.close();
  rmSync(home, { recursive: true, force: true });
});

/** A page at 1500x1000 in Paris, with the errors it logs. */
async function open(path: string): Promise<{ tab: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, timezoneId: 'Europe/Paris' });
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  tab.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await tab.goto(new URL(path, url).href);
  return { tab, errors };
}

describe('the projects page', () => {
  it('lists the projects and filters them by directory or id', async () => {
    const { tab, errors } = await open('/');
    expect(await tab.locator('#projects-title').textContent()).toBe('Claude Code projects');
    expect(await tab.title()).toBe('Claude Code projects');
    const rows = tab.locator('#projects-table tbody tr');
    expect(await rows.count()).toBe(2);
    expect(await rows.locator('td.wide .muted').allTextContents()).toEqual(
      expect.arrayContaining([`  ${PROJECTS.shop}`, `  ${PROJECTS.blog}`]),
    );
    await tab.locator('#projects-q').fill('blog');
    expect(await rows.count()).toBe(1);
    expect(await tab.locator('#projects-sessions').isHidden()).toBe(true);
    await rows.click();
    await tab.waitForURL(`${url}p/${PROJECTS.blog}`);
    expect(await tab.locator('#index-title').textContent()).toBe('Claude Code sessions');
    expect(errors).toEqual([]);
  });

  it('opens the conversation of a session id typed into the search with Enter, and links back to the project and the projects', async () => {
    const { tab, errors } = await open('/');
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe('projects-q');
    await tab.keyboard.type(SESSIONS.badge.slice(0, 8));
    expect(await tab.locator('#projects-sessions tbody tr').count()).toBe(1);
    expect(await tab.locator('#projects-sessions tbody tr a').first().textContent()).toBe(SESSIONS.badge);
    expect(await tab.locator('#projects-table').isHidden()).toBe(true);
    await tab.keyboard.press('Enter');
    await tab.waitForURL(`${url}p/${PROJECTS.shop}/s/${SESSIONS.badge}/conversation`);
    await tab.waitForSelector('.cv-turn');
    expect(await tab.locator('#cv-title').textContent()).toBe('Cart badge in the header');
    const back = tab.locator('#cv-back');
    expect(await back.isVisible()).toBe(true);
    await back.click();
    await tab.waitForURL(`${url}p/${PROJECTS.shop}`);
    expect(await tab.locator('#index-dir').textContent()).toBe('/home/dev/shop');
    const projects = tab.locator('#index-back');
    expect(await projects.textContent()).toBe('← All projects');
    await projects.click();
    await tab.waitForURL(url);
    expect(await tab.locator('#projects-title').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('opens a session’s timeline from the search, linked back to its project', async () => {
    const { tab, errors } = await open('/');
    await tab.locator('#projects-q').fill(SESSIONS.compaction);
    await tab.locator('#projects-sessions tbody tr').getByText('Timeline').click();
    await tab.waitForURL(`${url}p/${PROJECTS.shop}/s/${SESSIONS.compaction}`);
    expect(await tab.locator('#title').textContent()).toBe('Cart store reducer');
    expect(await tab.locator('#back').getAttribute('href')).toBe(`/p/${PROJECTS.shop}`);
    expect(errors).toEqual([]);
  });
});
