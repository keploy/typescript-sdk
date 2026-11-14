import fs from 'node:fs';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). Each test starts the
// Shared Worker /swk/s.js (or /swr/s.js), which sends what it drew and its
// location, and keeps what it got under its title:
// - 'shared worker early': a script of the test's own, run as the page's
//   document begins (after keploy's, before the browser can answer which
//   Service Workers the origin has), starts it.
// - 'shared worker announced': the page b, open before the page a registers
//   the Service Worker /swr/sw.js (scope /swr/, which b's own address is
//   not in), starts /swr/s.js once that Service Worker is active; the Service
//   Worker then sends the URL of each request it was asked.
// - 'shared worker known': the page starts it once the browser has answered
//   that its origin has no Service Worker.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

type Took = { __w: unknown[] };

test('shared worker early', async ({ page }) => {
  await page.context().addInitScript(() => {
    if (location.pathname !== '/long/early') return;
    const w: unknown[] = [];
    (window as unknown as Took).__w = w;
    const s = new SharedWorker('/swk/s.js');
    s.port.onmessage = (e) => w.push(e.data);
    s.port.start();
  });
  await page.goto(`${base}/long/early`);
  await page.waitForFunction(() => (window as unknown as Took).__w.length >= 1, null, { timeout: 20000 });
  keep(test.info().title, { w: await page.evaluate(() => (window as unknown as Took).__w) });
});

test('shared worker announced', async ({ context }) => {
  const b = await context.newPage();
  await b.goto(`${base}/long/b`);
  await b.evaluate(() => navigator.serviceWorker.getRegistrations());
  const a = await context.newPage();
  await a.goto(`${base}/swr/p`);
  await a.evaluate(async () => {
    await navigator.serviceWorker.register('/swr/sw.js');
    await navigator.serviceWorker.ready;
  });
  const got = await b.evaluate(() => new Promise((ok) => {
    const s = new SharedWorker('/swr/s.js');
    s.port.onmessage = (e) => ok(e.data);
    s.port.start();
  }));
  const seen = await a.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/swr/');
    const asked = r?.active;
    if (!asked) return null;
    return new Promise((ok) => {
      navigator.serviceWorker.addEventListener('message', (e) => ok(e.data), { once: true });
      asked.postMessage('seen');
    });
  });
  keep(test.info().title, { w: [got], seen });
});

test('shared worker known', async ({ page }) => {
  await page.goto(`${base}/long/known`);
  const got = await page.evaluate(async () => {
    await navigator.serviceWorker.getRegistrations();
    return new Promise((ok) => {
      const s = new SharedWorker('/swk/s.js');
      s.port.onmessage = (e) => ok(e.data);
      s.port.start();
    });
  });
  keep(test.info().title, { w: [got] });
});
