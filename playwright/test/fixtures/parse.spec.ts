import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). Two sandboxed frames at
// /fs in a page whose parser never ends (it waits on a script the server
// never answers: unparsed) or whose load never comes (an image the server
// never answers: unloaded), and a third the test puts in once both have
// drawn. The test then ends, and its context waits for that call until the
// test times out. A 1 ms navigation timeout, so that the fixture's wait for
// the parse's end holds only by its own timeout of 0 (none). removed: frame p
// at /rparsed holds u0 and u1 and a script the server answers only once the
// test asks (a browser may not end a removed frame's calls); the test removes
// p once both have drawn, and its line must come before its next step.
const base = process.env.DRAWS_BASE ?? '';
test.use({ navigationTimeout: 1 });

async function drawn(p: Page, n: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const f = p.frame(n);
    if (f) {
      try { if (await f.evaluate(() => (window as unknown as { __draws?: unknown }).__draws !== undefined)) return; } catch { /* not yet */ }
    }
    await p.waitForTimeout(25);
  }
  throw new Error(`frame ${n} drew nothing`);
}

for (const [name, waitUntil] of [['unparsed', 'commit'], ['unloaded', 'domcontentloaded']] as const) {
  test(name, async ({ page }) => {
    await page.goto(`${base}/${name}`, { waitUntil, timeout: 0 });
    for (const n of ['u0', 'u1']) await drawn(page, n);
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.name = 'u2';
      f.setAttribute('sandbox', 'allow-scripts');
      f.src = '/fs';
      document.body.appendChild(f);
    });
    await drawn(page, 'u2');
  });
}

test('removed', async ({ page }) => {
  await page.goto(`${base}/removed`, { waitUntil: 'commit', timeout: 0 });
  for (const n of ['u0', 'u1']) await drawn(page, n);
  const gone = page.waitForEvent('framedetached', { predicate: (f) => f.name() === 'p', timeout: 0 });
  await page.evaluate(() => document.querySelector('iframe[name="p"]')!.remove());
  await gone;
  // A call to the browser and back: every promise p's removal settled has run.
  await page.evaluate(() => 0);
  await test.step('p removed', async () => {});
  await page.evaluate(async () => { await fetch('/rrelease'); });
});
