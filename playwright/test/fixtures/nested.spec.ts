import fs from 'node:fs';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). The page at /nw starts a
// classic and a module Web Worker, each of which starts Web Workers beside
// it (the classic one: a classic one twice at one path, one of which starts
// another, a module one, and one from a blob: URL twice), and a Shared Worker,
// which says whether its scope has Worker. Each worker sends what it drew
// and its location, which the worker that started it passes on. The test
// keeps them, under its title.
const base = process.env.DRAWS_BASE ?? '';

test('nested', async ({ page }) => {
  await page.goto(`${base}/nw`);
  await page.waitForFunction(() => {
    const w = (window as unknown as { __w: { kind: string; worker?: string }[] }).__w;
    const a = w.find((x) => x.kind === 'a');
    return a !== undefined && w.length >= (a.worker === 'function' ? 10 : 3);
  }, null, { timeout: 20000 });
  fs.writeFileSync(`${process.env.MARKER_DIR}/nested.json`, JSON.stringify(await page.evaluate(() => (window as unknown as { __w: unknown[] }).__w)));
});
