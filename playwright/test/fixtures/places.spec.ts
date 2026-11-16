import fs from 'node:fs';
import type { Frame, Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). Frames of a page that
// come, or load, in an order a replay may change: /host puts in a frame of
// its own origin (a, /fa) and two cross-site ones (c, /fc and w, /fw) in
// the order PLACES_ORDER names, as third-party scripts that load in network
// order put theirs in; /race holds two frames at one path, and the server
// answers the one PLACES_SLOW names late; /before puts a frame in before
// another at its path whose document is still loading; /set is a frameset.
// Each test keeps what its frames drew as they loaded.
const base = process.env.DRAWS_BASE ?? '';
const order = process.env.PLACES_ORDER ?? 'acw';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
const read = (): unknown => (window as unknown as { __draws: unknown }).__draws;

// The frame named n once its document at path has drawn.
async function loaded(p: Page, n: string, path: string): Promise<Frame> {
  for (let i = 0; i < 400; i++) {
    const f = p.frame(n);
    if (f && new URL(f.url(), 'http://x').pathname === path) {
      try { if (await f.evaluate(() => (window as unknown as { __draws?: unknown }).__draws !== undefined)) return f; } catch { /* not yet */ }
    }
    await p.waitForTimeout(25);
  }
  throw new Error(`no frame ${n} at ${path} among ${p.frames().map((x) => `${x.name()} ${x.url()}`).join(', ')}`);
}
const drawsOf = async (p: Page, n: string, path: string): Promise<unknown> => (await loaded(p, n, path)).evaluate(read);

test('order', async ({ page }) => {
  await page.goto(`${base}/host?order=${order}`);
  const out: Record<string, unknown> = { top: await page.evaluate(read) };
  for (const [n, at] of [['a', '/fa'], ['c', '/fc'], ['w', '/fw']]) out[n] = await drawsOf(page, n, at);
  keep('order', out);
});

test('race', async ({ page }) => {
  await page.goto(`${base}/race?slow=${process.env.PLACES_SLOW ?? '1'}`);
  const drew = { r0: await drawsOf(page, 'r0', '/fr'), r1: await drawsOf(page, 'r1', '/fr') };
  // Both taken out and put back in one task: each element holds another
  // window, and their documents load in the server's order again.
  await page.evaluate(() => {
    const fs = ['r0', 'r1'].map((n) => document.querySelector(`iframe[name="${n}"]`)!);
    for (const f of fs) f.remove();
    for (const f of fs) document.body.appendChild(f);
  });
  keep('race', { ...drew, again0: await drawsOf(page, 'r0', '/fr'), again1: await drawsOf(page, 'r1', '/fr') });
});

test('remount', async ({ page }) => {
  // A frame of the page's origin (it has session storage) removed, and
  // another put in at the same path and index.
  await page.goto(`${base}/host?order=a`);
  const first = await drawsOf(page, 'a', '/fa');
  await page.evaluate(() => {
    document.querySelector('iframe[name="a"]')!.remove();
    const f = document.createElement('iframe');
    f.name = 'a2';
    f.src = '/fa';
    document.body.appendChild(f);
  });
  keep('remount', { first, again: await drawsOf(page, 'a2', '/fa') });
});

test('nested', async ({ page }) => {
  // x and n at the top; inside n (the top's second frame), y, z and nn
  // (n's third).
  await page.goto(`${base}/nested`);
  const out: Record<string, unknown> = {};
  for (const [n, at] of [['x', '/fa'], ['n', '/fn'], ['y', '/fb'], ['z', '/fb'], ['nn', '/fa']]) out[n] = await drawsOf(page, n, at);
  keep('nested', out);
});

test('navigate', async ({ page }) => {
  // One frame loads /fa, then /fb, then /fa again: its element still asks
  // for /fa.
  await page.goto(`${base}/host?order=a`);
  const drew = [await drawsOf(page, 'a', '/fa')];
  for (const at of ['/fb', '/fa']) {
    await page.frame('a')!.goto(`${base}${at}`);
    drew.push(await drawsOf(page, 'a', at));
  }
  keep('navigate', drew);
});

for (const [name, wrap] of [['before', '0'], ['beforewrapped', '1']]) {
  test(name, async ({ page }) => {
    // b0 put in (in a div for beforewrapped), its document answered late;
    // b1 put in before it 50 ms later, its document answered at once.
    await page.goto(`${base}/before?wrap=${wrap}`);
    keep(name, { b0: await drawsOf(page, 'b0', '/fr'), b1: await drawsOf(page, 'b1', '/fr') });
  });
}

test('frameset', async ({ page }) => {
  await page.goto(`${base}/set`);
  keep('frameset', { f0: await drawsOf(page, 'f0', '/fa'), f1: await drawsOf(page, 'f1', '/fa') });
});
