import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER), under keploy and with no
// keploy. Each test has one request of its page fail, from the page at /sv,
// and keeps what the page saw of it (a fetch's 'failed', a Web Worker's
// 'error' or its message) and the text the page's requestfailed event gave
// for it (its failure's errorText; 'finished' when it ended as the browser's
// requestfinished instead), under the test's title: a fetch the test's own
// route aborts with an error code, on its page and on its context, and with
// none; a Web Worker's script the test's route aborts with an error code,
// with blockedbyclient and with none; and (Chromium, seeded: keploy stops
// its load) a Web Worker's script the server redirects.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

// The end the page's request events give the first request of the page at
// path: the failure's text, or 'finished'.
const ended = (page: Page, path: string): Promise<string> => new Promise((resolve) => {
  const at = (u: string): boolean => new URL(u).pathname === path;
  page.on('requestfailed', (r) => { if (at(r.url())) resolve(r.failure()?.errorText ?? 'none'); });
  page.on('requestfinished', (r) => { if (at(r.url())) resolve('finished'); });
});

const fetched = async (page: Page, path: string): Promise<void> => {
  await page.goto(`${base}/sv`);
  const end = ended(page, path);
  const saw = await page.evaluate((p) => fetch(p).then(() => 'ok', () => 'failed'), path);
  keep(test.info().title, [saw, await end]);
};

const started = async (page: Page, path: string): Promise<void> => {
  await page.goto(`${base}/sv`);
  const end = ended(page, path);
  const saw = await page.evaluate((p) => new Promise((resolve) => {
    const w = new Worker(p);
    w.onmessage = (e) => resolve((e.data as { k?: string }).k ?? 'message');
    w.onerror = () => resolve('error');
  }), path);
  keep(test.info().title, [saw, await end]);
};

test('abort with a code on page', async ({ page }) => {
  await page.route('**/ab/x', (r) => r.abort('accessdenied'));
  await fetched(page, '/ab/x');
});

test('abort with a code on context', async ({ context, page }) => {
  await context.route('**/ab/x', (r) => r.abort('accessdenied'));
  await fetched(page, '/ab/x');
});

test('abort with no code on page', async ({ page }) => {
  await page.route('**/ab/x', (r) => r.abort());
  await fetched(page, '/ab/x');
});

test('abort a worker script with a code', async ({ page }) => {
  await page.route('**/rd/w.js', (r) => r.abort('accessdenied'));
  await started(page, '/rd/w.js');
});

test('abort a worker script with blockedbyclient', async ({ page }) => {
  await page.route('**/rd/w.js', (r) => r.abort('blockedbyclient'));
  await started(page, '/rd/w.js');
});

test('abort a worker script with no code', async ({ page }) => {
  await page.route('**/rd/w.js', (r) => r.abort());
  await started(page, '/rd/w.js');
});

test('a worker script the server redirects', async ({ page }) => {
  await started(page, '/rd/w.js');
});
