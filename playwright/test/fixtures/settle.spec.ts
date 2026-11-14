import type { Frame, Page } from '@playwright/test';
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
  // in flight when the body ends. The body ends once the test has seen the
  // image's request and the document's end, so the call settle names is the
  // image alone. By then the test has seen the frame's commit too (goto
  // resolves after it), in whichever order the browser reported the two.
  const sent = page.waitForRequest(/\/slow$/);
  const doc = await page.goto(`${base}/loads`, { waitUntil: 'commit' });
  await sent;
  await doc?.finished();
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
// A frame from another site, loaded and ready (the payment form's frame).
const crossSiteChild = async (page: Page): Promise<Frame> => {
  await page.goto(`${base}/page`);
  const attached = page.waitForEvent('frameattached');
  await page.evaluate((src) => new Promise<void>((resolve) => {
    const f = document.createElement('iframe');
    f.id = 'child';
    f.onload = () => resolve();
    f.src = src;
    document.body.appendChild(f);
  }), `${base.replace('//127.0.0.1:', '//localhost:')}/page?child`);
  return attached;
};
// The page loads another document: its frames go with the old one.
const nextDocument = (page: Page) => page.goto(`${base}/page?next`);
test('a beacon its frame sends as the page loads another document', async ({ page }) => {
  // Telemetry a frame sends as its page hides (a payment form's). A
  // keepalive call outlives its document: the browser still sends it.
  const child = await crossSiteChild(page);
  await child.evaluate(() => { addEventListener('pagehide', () => { navigator.sendBeacon('/beacon', 'b'); }); });
  await nextDocument(page);
  await reached();
});
test('a beacon its frame had in flight when the page loads another document', async ({ page }) => {
  const child = await crossSiteChild(page);
  const sent = page.waitForRequest(/\/beacon$/);
  await child.evaluate(() => { navigator.sendBeacon('/beacon', 'b'); });
  await sent;
  await reached();
  await nextDocument(page);
});
test('a keepalive fetch its frame had in flight when the page loads another document', async ({ page }) => {
  const child = await crossSiteChild(page);
  const sent = page.waitForRequest(/\/beacon$/);
  await child.evaluate(() => { void fetch('/beacon', { method: 'POST', body: 'b', keepalive: true }); });
  await sent;
  await reached();
  await nextDocument(page);
});
test('a call its frame had in flight when the page loads another document', async ({ page }) => {
  const child = await crossSiteChild(page);
  const sent = page.waitForRequest(/\/slow$/);
  await child.evaluate(() => { void fetch('/slow'); });
  await sent;
  await reached();
  await nextDocument(page);
});
test('a document its frame was still loading when the page loads another document', async ({ page }) => {
  // A frame whose own document has not finished loading (a payment form's
  // frame, loaded lazily) goes with the page's old document: Playwright
  // reports no end for the frame's own navigation request either. The
  // frame commits /slowdoc, whose last byte the page server holds.
  const child = await crossSiteChild(page);
  await child.goto(`${base.replace('//127.0.0.1:', '//localhost:')}/slowdoc`, { waitUntil: 'commit' });
  await nextDocument(page);
});
test('a beacon in flight from the page', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/beacon$/);
  await page.evaluate(() => { navigator.sendBeacon('/beacon', 'b'); });
  await sent;
  await reached();
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
test('a page that starts a Shared Worker', async ({ page }) => {
  await page.goto(`${base}/page`);
  // The worker answers once its script has run; its URL's fragment is no
  // part of the request, and its query no part of the address said.
  const said = await page.evaluate(() => new Promise<string>((resolve) => {
    const w = new SharedWorker('/shared.js?v=1#f');
    w.port.onmessage = (e) => resolve(String(e.data));
  }));
  if (said !== 'up') throw new Error(`the Shared Worker said ${said}`);
});
