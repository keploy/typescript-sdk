import fs from 'node:fs';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). The page at /wk starts
// a classic Web Worker (which loads a script beside it with importScripts),
// a module Web Worker (which imports a module beside it) and a Shared
// Worker; each sends what it drew, its location and what it loaded. The
// test keeps them.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

test('workers', async ({ page }) => {
  await page.goto(`${base}/wk`);
  await page.waitForFunction(() => (window as unknown as { __w: unknown[] }).__w.length >= 3, null, { timeout: 20000 });
  keep('workers', await page.evaluate(() => (window as unknown as { __w: unknown[] }).__w));
});
