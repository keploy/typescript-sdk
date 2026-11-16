import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Pages of one test at one path (DRAWS_BASE's /draws, with its cross-site
// /frame): two tabs the test opens, two popups the first opens at one
// moment, two pages asked for at once, a frame of the page's own origin
// (/nest), in a tab and in a popup, and a popup opened with noopener.
// Each test keeps what its pages drew.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
const read = (): unknown => (window as unknown as { __draws: unknown }).__draws;

async function drew(p: Page): Promise<{ top: unknown; frame: unknown }> {
  await p.waitForLoadState('load');
  const frame = p.frames().find((f) => f.url().endsWith('/frame'));
  if (!frame) throw new Error(`no /frame among ${p.frames().map((f) => f.url()).join(', ')}`);
  return { top: await p.evaluate(read), frame: await frame.evaluate(read) };
}

test('tabs', async ({ page, context }) => {
  await page.goto(`${base}/draws`);
  const second = await context.newPage();
  await second.goto(`${base}/draws`);
  // Two popups at one moment, told apart by the names they were opened with.
  const popups: Page[] = [];
  const both = new Promise<void>((resolve) => {
    context.on('page', (p) => { popups.push(p); if (popups.length === 2) resolve(); });
  });
  await page.evaluate((u) => { window.open(u, 'one'); window.open(u, 'two'); }, `${base}/draws`);
  await both;
  const named: Record<string, Page> = {};
  for (const p of popups) { await p.waitForLoadState('load'); named[await p.evaluate(() => window.name)] = p; }
  keep('tabs', { first: await drew(page), second: await drew(second), one: await drew(named.one), two: await drew(named.two) });
});

test('atonce', async ({ context }) => {
  // Asked for at once: each keeps its place in the order the test asked.
  const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
  await b.goto(`${base}/draws`);
  await a.goto(`${base}/draws`);
  keep('atonce', { a: await drew(a), b: await drew(b) });
});

test('nest', async ({ page }) => {
  await page.goto(`${base}/nest`);
  keep('nest', await drew(page));
});

test('popnest', async ({ page, context }) => {
  // A popup at /nest, whose frame of its own origin is placed by it.
  await page.goto(`${base}/draws`);
  const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate((u) => { window.open(u); }, `${base}/nest`)]);
  keep('popnest', await drew(p));
});

test('noopener', async ({ page, context }) => {
  await page.goto(`${base}/draws`);
  const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate((u) => { window.open(u, '_blank', 'noopener'); }, `${base}/draws`)]);
  keep('noopener', { first: await drew(page), popup: await drew(p) });
});
