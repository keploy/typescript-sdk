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
test('a Web Worker its page terminates while its script loads', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/heldw\.m?js(\?|$)/);
  await page.evaluate(() => {
    const g = globalThis as unknown as { w: Worker[] };
    g.w = [new Worker('/heldw.js'), new Worker('/heldw.mjs', { type: 'module' })];
  });
  await sent;
  await reached();
  await page.evaluate(() => { (globalThis as unknown as { w: Worker[] }).w.forEach((w) => w.terminate()); });
});
test('two Web Workers at one URL, the second terminated while their scripts load', async ({ page }) => {
  await page.goto(`${base}/page`);
  const sent = page.waitForRequest(/\/heldw\.js(\?|$)/);
  await page.evaluate(() => {
    const g = globalThis as unknown as { w: Worker[]; up: Promise<unknown> };
    g.w = [new Worker('/heldw.js'), new Worker('/heldw.js')];
    // The first worker's script runs once the server answers it.
    g.up = new Promise((resolve) => { g.w[0].onmessage = (e) => resolve(e.data); });
  });
  await sent;
  await reached();
  await page.evaluate(() => { (globalThis as unknown as { w: Worker[] }).w[1].terminate(); });
});
// A Web Worker whose top-level code runs on (10 s) after its first message,
// which the body waits for (its URL's fragment is no part of the request).
test('a Web Worker whose top-level code runs long', async ({ page }) => {
  await page.goto(`${base}/page`);
  const said = await page.evaluate(() => new Promise<string>((resolve) => {
    const g = globalThis as unknown as { w: Worker };
    g.w = new Worker('/busyw.js#f');
    g.w.onmessage = (e) => resolve(String(e.data));
  }));
  if (said !== 'busy') throw new Error(`the Web Worker said ${said}`);
});
// The test's own routes answer a classic Web Worker's script with a 302, a
// module one's with a 307 and a page fetch with a 302 (each to a URL the
// page server does not know). Chromium reports no end for such a worker
// load (its worker never starts), Firefox none for the redirect's first
// request, and WebKit refuses the answer: Playwright's own error fails the
// test there, and the request stays with the route.
test("requests the test's route answers with a redirect", async ({ page }) => {
  await page.goto(`${base}/page`);
  // Playwright ends a test at the first error a route's handler throws,
  // while the other handlers may still wait on their fulfill: their
  // requests are then in flight, and settle's step names them. So each
  // handler, once its fulfill has returned or thrown, waits until every
  // route's first fulfill has, and then throws what its fulfill threw: in
  // WebKit the three handlers throw together. The body ends once each
  // route's first handler has returned (never, in WebKit).
  const fulfilled: Promise<void>[] = [];
  const returned: Promise<void>[] = [];
  let together: Promise<unknown> = Promise.resolve();
  const redirect = (glob: string, status: number, to: string): Promise<void> => {
    let done = (): void => {};
    let end = (): void => {};
    fulfilled.push(new Promise<void>((resolve) => { done = resolve; }));
    returned.push(new Promise<void>((resolve) => { end = resolve; }));
    return page.route(glob, async (r) => {
      let refused: { error: unknown } | null = null;
      try {
        await r.fulfill({ status, headers: { location: to } });
      } catch (error) {
        refused = { error };
      }
      done();
      await together;
      if (refused !== null) throw refused.error;
      end();
    });
  };
  await redirect('**/rw.js', 302, `${base}/v2/rw.js`);
  await redirect('**/rwm.js', 307, `${base}/v2/rwm.js`);
  await redirect('**/rf', 302, `${base}/v2/rf`);
  together = Promise.all(fulfilled);
  const sent = Promise.all([/\/rw\.js(\?|$)/, /\/rwm\.js(\?|$)/, /\/rf$/].map((u) => page.waitForRequest(u)));
  await page.evaluate(() => {
    const g = globalThis as unknown as { w: Worker[] };
    g.w = [new Worker('/rw.js'), new Worker('/rwm.js', { type: 'module' })];
    void fetch('/rf').catch(() => {});
  });
  await sent;
  await Promise.all(returned);
});
// WebKit refuses a redirect, and no route can then reach the request:
// Playwright's continue() of it fails with Playwright's own error, which
// the handler throws and which fails the test. The body ends once the
// handler has returned (never, in WebKit). WebKit holds the request until
// the context is deleted, and may then send it to the server.
test("a call the test's route tries to send on after the browser refused its answer", async ({ page }) => {
  await page.goto(`${base}/page`);
  let end = (): void => {};
  const returned = new Promise<void>((resolve) => { end = resolve; });
  await page.route('**/slow', async (r) => {
    await r.fulfill({ status: 302, headers: { location: `${base}/page` } }).catch(() => {});
    await r.continue();
    end();
  });
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow').catch(() => {}); });
  await sent;
  await returned;
});
// The same with the route's abort(), which fails with Playwright's own
// error too.
test("a call the test's route tries to fail after the browser refused its answer", async ({ page }) => {
  await page.goto(`${base}/page`);
  let end = (): void => {};
  const returned = new Promise<void>((resolve) => { end = resolve; });
  await page.route('**/slow', async (r) => {
    await r.fulfill({ status: 302, headers: { location: `${base}/page` } }).catch(() => {});
    await r.abort();
    end();
  });
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow').catch(() => {}); });
  await sent;
  await returned;
});
// A route falls back, then throws: Playwright hands the call to no other
// route and sends it nowhere, and the handler's error fails the test. The
// body never ends: Playwright's runner ends the test at that error.
test("a call the test's route falls back on and then throws", async ({ page }) => {
  await page.goto(`${base}/page`);
  await page.route('**/slow', async (r) => {
    await r.fallback();
    throw new Error("the test's route handler threw after its fallback");
  });
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow').catch(() => {}); });
  await sent;
  await new Promise<void>(() => {});
});
// A route sends the call on, then tries to answer it too: Playwright's
// fulfill throws (the route is already handled), and so does the handler,
// which fails the test.
test("a call the test's route sends on and then tries to answer", async ({ page }) => {
  await page.goto(`${base}/page`);
  await page.route('**/slow', async (r) => {
    await r.continue();
    await r.fulfill({ status: 302, headers: { location: `${base}/page` } });
  });
  const sent = page.waitForRequest(/\/slow$/);
  await page.evaluate(() => { void fetch('/slow'); });
  await sent;
  await reached();
});
