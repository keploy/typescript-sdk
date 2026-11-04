import { test } from '../../dist';

const base = process.env.SLOW_BASE ?? '';
// Resolves once the page server has received /slow. A spec that cancels its
// call waits for this first: the browser's request event comes before the
// call reaches the server, and the row asserts that it did.
const reached = (): Promise<string> => fetch(`${base}/seen`).then((r) => r.text());
test.afterEach(async () => {
  if (!process.env.NO_RELEASE) await fetch(`${base}/release`);
});
test('a call in flight when the body ends', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
});
test('a call its page cancelled by loading another document', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  await reached();
  await page.goto(`${base}/page?next`);
});
test('a call its new document makes as it loads', async ({ page }) => {
  // The document's image, which its parser asks for as it loads, is still
  // in flight when the body ends.
  await page.goto(`${base}/loads`, { waitUntil: 'commit' });
  await reached();
});
test('a call in flight across a route change inside the page', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  const routed = page.waitForEvent('framenavigated');
  await page.evaluate(() => { void fetch('/slow'); history.pushState({}, '', '/page?route'); });
  await sent;
  await routed;
});
test('a call in flight across a navigation answered 204', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  const answered = page.waitForResponse(/\/nocontent$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  // A 204 answer to a navigation leaves the document in place: nothing is cancelled.
  await page.evaluate(() => { location.href = '/nocontent'; });
  await answered;
  const routed = page.waitForEvent('framenavigated');
  await page.evaluate(() => { history.pushState({}, '', '/page?route'); });
  await routed;
});
test('a call in flight across a navigation answered 205', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  const answered = page.waitForResponse(/\/resetcontent$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  // A 205 answer to a navigation leaves the document in place, as a 204 does.
  await page.evaluate(() => { location.href = '/resetcontent'; });
  await answered;
  const routed = page.waitForEvent('framenavigated');
  await page.evaluate(() => { history.pushState({}, '', '/page?route'); });
  await routed;
});
test('a call in flight across a download', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  const answered = page.waitForResponse(/\/download$/);
  const downloaded = page.waitForEvent('download');
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  // A navigation answered with an attachment is a download: the document stays.
  await page.evaluate(() => { location.href = '/download'; });
  await answered;
  await downloaded;
  const routed = page.waitForEvent('framenavigated');
  await page.evaluate(() => { history.pushState({}, '', '/page?route'); });
  await routed;
});
test('a call its removed cross-site frame had in flight', async ({ page }) => {
  // A frame from another site (localhost under a 127.0.0.1 page), as a
  // payment form's is. The browser ends the calls it had in flight when it is
  // removed.
  await page.goto(`${base}/page`);
  const attached = page.waitForEvent('frameattached');
  await page.evaluate((src) => new Promise<void>((resolve) => {
    const f = document.createElement('iframe');
    f.id = 'child';
    f.onload = () => resolve();
    f.src = src;
    document.body.appendChild(f);
  }), `${base.replace('//127.0.0.1:', '//localhost:')}/page?child`);
  const child = await attached;
  const sent = page.waitForRequest(/\/slow$/);
  const detached = page.waitForEvent('framedetached');
  await child.evaluate(() => { void fetch('/slow'); });
  await sent;
  await reached();
  await page.evaluate(() => { document.getElementById('child')?.remove(); });
  await detached;
});
test('a call its closed page had in flight', async ({ page, context }) => {
  await page.goto(`${base}/page`);
  const other = await context.newPage();
  await other.goto(`${base}/page?other`);
  const sent = other.waitForRequest(/\/slow$/);
  await other.evaluate(() => { void fetch('/slow'); });
  await sent;
  await reached();
  await other.close();
});
test('a document still loading after its frame commits', async ({ page }) => {
  // The navigation request itself stays in flight until the document's last
  // byte: committing the new document cancels only the old document's calls.
  await page.goto(`${base}/slowdoc`, { waitUntil: 'commit' });
});
test('a call in flight while another page of the test closes', async ({ page, context }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  const other = await context.newPage();
  await other.goto(`${base}/page?other`);
  await other.close();
});
test('a call in flight across a route change after an answered call', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  await page.evaluate(() => fetch('/page').then((r) => r.text()));
  const routed = page.waitForEvent('framenavigated');
  await page.evaluate(() => { history.pushState({}, '', '/page?route'); });
  await routed;
});
test('a call in flight when the test closes its own context', async ({ page, context }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  await reached();
  await context.close();
});
test('a call its service worker has in flight', async ({ page, context }) => {
  // A service worker's call has no frame (Playwright's request.frame() throws
  // for it). It is counted like a page's call, and no page change drops it.
  await page.goto(`${base}/page`);
  const sent = context.waitForEvent('request', (r) => r.url().endsWith('/slow'));
  await page.evaluate(() => { void navigator.serviceWorker.register('/sw.js'); });
  await sent;
});
test('a service worker call in flight when the test closes its own context', async ({ page, context }) => {
  // Closing the context ends its service workers too. Chromium reports no end
  // for the worker's call, and no page's close drops it (it has no frame).
  await page.goto(`${base}/page`);
  const sent = context.waitForEvent('request', (r) => r.url().endsWith('/slow'));
  await page.evaluate(() => { void navigator.serviceWorker.register('/sw.js'); });
  await sent;
  await reached();
  await context.close();
});
test('a service worker call in flight while another page of the test closes', async ({ page, context }) => {
  await page.goto(`${base}/page`);
  const sent = context.waitForEvent('request', (r) => r.url().endsWith('/slow'));
  await page.evaluate(() => { void navigator.serviceWorker.register('/sw.js'); });
  await sent;
  const other = await context.newPage();
  await other.goto(`${base}/page?other`);
  await other.close();
});
test('a call in flight across a lowercase attachment download', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/slow$/);
  const answered = page.waitForResponse(/\/download-lower$/);
  const downloaded = page.waitForEvent('download');
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  // The common spelling, "attachment", is a download as "Attachment" is.
  await page.evaluate(() => { location.href = '/download-lower'; });
  await answered;
  await downloaded;
  const routed = page.waitForEvent('framenavigated');
  await page.evaluate(() => { history.pushState({}, '', '/page?route'); });
  await routed;
});
