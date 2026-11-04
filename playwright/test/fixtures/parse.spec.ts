import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). Two sandboxed frames at
// /fs in a page whose parser never ends (it waits on a script the server
// never answers: unparsed) or whose load never comes (an image the server
// never answers: unloaded), and a third the test puts in once both have
// drawn. The test then ends, and its context waits for that call until the
// test times out.
const base = process.env.DRAWS_BASE ?? '';

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
    await page.goto(`${base}/${name}`, { waitUntil });
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
