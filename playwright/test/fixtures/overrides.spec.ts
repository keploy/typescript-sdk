import fs from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). Each test adds a route of
// its own, on its page or on its context, that continues or falls back with
// what the app's server needs for a worker's script: a header it answers
// 401 without (/ov/a*.js), or a stand-in at another URL for a script it does
// not have (/ov/o*.js, answered by /ov/m*.js). The last continues with the
// browser's own headers, and its own URL and method (/ov/p*.js). Then the test's page starts a Web
// Worker and a Shared Worker at those scripts and keeps what each sent (its
// kind, location and draws), or 'error', under the test's title.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

// With Playwright blocking Service Workers, keploy knows at once that none
// can answer a Shared Worker's script, and marks it.
test.use({ serviceWorkers: 'block' });

const start = async (page: Page, k: string): Promise<void> => {
  await page.goto(`${base}/ov`);
  keep(test.info().title, await page.evaluate((x) => Promise.all([
    new Promise((resolve) => {
      const w = new Worker(`/ov/${x}w.js`);
      w.onmessage = (e) => resolve(e.data);
      w.onerror = () => resolve('error');
    }),
    new Promise((resolve) => {
      const s = new SharedWorker(`/ov/${x}s.js`);
      s.port.onmessage = (e) => resolve(e.data);
      s.onerror = () => resolve('error');
      // A Shared Worker whose script failed may report nothing.
      setTimeout(() => resolve('none'), 10000);
    }),
  ]), k));
};
const auth = (r: Route): { headers: Record<string, string> } => ({ headers: { ...r.request().headers(), 'x-auth': 'k' } });
const standIn = (r: Route): { url: string } => ({ url: r.request().url().replace('/ov/o', '/ov/m') });

test('continue headers on page', async ({ page }) => {
  await page.route('**/*', (r) => r.continue(auth(r)));
  await start(page, 'a');
});

test('continue headers on context', async ({ context, page }) => {
  await context.route('**/*', (r) => r.continue(auth(r)));
  await start(page, 'a');
});

test('continue url on page', async ({ page }) => {
  await page.route('**/ov/o*.js', (r) => r.continue(standIn(r)));
  await start(page, 'o');
});

test('continue url on context', async ({ context, page }) => {
  await context.route('**/ov/o*.js', (r) => r.continue(standIn(r)));
  await start(page, 'o');
});

test('fallback headers on page', async ({ page }) => {
  await page.route('**/*', (r) => r.fallback(auth(r)));
  await start(page, 'a');
});

test('fallback headers on context', async ({ context, page }) => {
  await context.route('**/*', (r) => r.fallback(auth(r)));
  await start(page, 'a');
});

test('fallback url on page', async ({ page }) => {
  await page.route('**/ov/o*.js', (r) => r.fallback(standIn(r)));
  await start(page, 'o');
});

test('browser headers on page', async ({ page }) => {
  await page.route('**/*', (r) => r.continue({ headers: r.request().headers() }));
  await start(page, 'p');
});

test('own url and method on page', async ({ page }) => {
  await page.route('**/ov/p*.js', (r) => r.continue({ url: r.request().url(), method: r.request().method() }));
  await start(page, 'p');
});
