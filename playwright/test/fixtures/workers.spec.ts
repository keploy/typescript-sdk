import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). The page at /wk starts
// a classic Web Worker (which loads a script beside it with importScripts),
// a module Web Worker (which imports a module beside it), a classic Shared
// Worker and three module Shared Workers (each importing a module beside
// it; one connected to twice); each sends what it drew, its location, what
// it loaded and its stack, and each Web Worker answers the message the page
// posts as it starts it and sends what its own code got at its script's URL.
// Each worker sends what its fetch and Request sent.
// The test keeps them, under its title.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

const workers = async (page: Page): Promise<void> => {
  await page.goto(`${base}/wk`);
  await page.waitForFunction(() => (window as unknown as { __w: unknown[] }).__w.length >= 17, null, { timeout: 20000 });
  keep(test.info().title, await page.evaluate(() => (window as unknown as { __w: unknown[] }).__w));
};

test('workers', async ({ page }) => {
  await workers(page);
});

// The same, behind the test's own catch-all routes, on its context and on
// its page, each continuing every request (as a suite that logs requests,
// or adds a header, has). Then a route of the test's own answers the
// script of a Web Worker the page starts twice at one path itself: each
// sends its location.
test('workers behind routes', async ({ page }) => {
  await page.context().route('**/*', (route) => route.continue());
  await page.route('**/*', (route) => route.continue());
  await page.route('**/wk/own.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'postMessage(location.href);' }));
  await workers(page);
  keep('own', await page.evaluate(() => Promise.all([0, 1].map(() => new Promise((resolve) => {
    new Worker('/wk/own.js').onmessage = (e) => resolve(e.data);
  })))));
});
