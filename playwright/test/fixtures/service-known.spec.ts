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
// - 'shared worker registering': the page a registers /swh/sw.js (scope
//   /swh/), whose script the server answers only once the page b, opened
//   while the register is in flight, has started /swh/s.js, after the
//   browser answered b's own lock read and getRegistrations (which come
//   after keploy's).
// - 'shared worker known': the page starts it once the browser has answered
//   its own lock read and that its origin has no Service Worker (keploy asks
//   for the registrations once its lock read answers, so a page that waits
//   for both hears after keploy).
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

type Reg = { __reg: Promise<ServiceWorkerRegistration> };

test('shared worker registering', async ({ context }) => {
  const a = await context.newPage();
  await a.goto(`${base}/swh/p`);
  await a.evaluate(() => { (window as unknown as Reg).__reg = navigator.serviceWorker.register('/swh/sw.js'); });
  await fetch(`${base}/swh/asked`);
  const b = await context.newPage();
  await b.goto(`${base}/long/registering`);
  const got = await b.evaluate(async () => {
    await navigator.locks.query();
    await navigator.serviceWorker.getRegistrations();
    return new Promise((ok) => {
      const s = new SharedWorker('/swh/s.js');
      s.port.onmessage = (e) => ok(e.data);
      s.port.start();
    });
  });
  await fetch(`${base}/swh/release`);
  await a.evaluate(() => (window as unknown as Reg).__reg.then(() => true));
  keep(test.info().title, { w: [got] });
});

test('shared worker known', async ({ page }) => {
  await page.goto(`${base}/long/known`);
  const got = await page.evaluate(async () => {
    await navigator.locks.query();
    await navigator.serviceWorker.getRegistrations();
    return new Promise((ok) => {
      const s = new SharedWorker('/swk/s.js');
      s.port.onmessage = (e) => ok(e.data);
      s.port.start();
    });
  });
  keep(test.info().title, { w: [got] });
});
