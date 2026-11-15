import fs from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER), seeded and with seeding
// off. Each test adds routes of its own that treat a worker script's loads
// apart: one that answers once (times: 1), one that picks the worker's
// script by its destination, one that counts its loads, then starts Web
// Workers at /ov/<k>w.js (a needs x-auth: k; n and g need it too, under
// Referrer-Policy no-referrer and origin; p asks nothing) and keeps what
// each sent (its kind, location and draws), or 'error', under its title.
// The doc tests start them from a document under a referrer policy of its
// own, at /ovd/<how>/<policy> (a meta tag, or a header on the HTML only).
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

test.use({ serviceWorkers: 'block' });

type Start = { url: string; type?: 'classic' | 'module'; shared?: boolean };
const start = async (page: Page, list: Start[], doc = '/ov'): Promise<void> => {
  await page.goto(`${base}${doc}`);
  const got: unknown[] = [];
  // One at a time, in order: each worker's place is its order.
  for (const s of list) {
    got.push(await page.evaluate((x) => new Promise((resolve) => {
      if (x.shared) {
        const w = new SharedWorker(x.url, { type: x.type ?? 'classic' });
        w.port.onmessage = (e) => resolve(e.data);
        w.onerror = () => resolve('error');
        setTimeout(() => resolve('none'), 10000);
        return;
      }
      const w = new Worker(x.url, { type: x.type ?? 'classic' });
      w.onmessage = (e) => resolve(e.data);
      w.onerror = () => resolve('error');
    }), s));
  }
  keep(test.info().title, got);
};
const auth = (r: Route): { headers: Record<string, string> } => ({ headers: { ...r.request().headers(), 'x-auth': 'k' } });

test('once on page', async ({ page }) => {
  await page.route('**/ov/aw.js', (r) => r.continue(auth(r)), { times: 1 });
  await start(page, [{ url: '/ov/aw.js' }]);
});

test('once on context, module', async ({ context, page }) => {
  await context.route('**/ov/aw.js', (r) => r.continue(auth(r)), { times: 1 });
  await start(page, [{ url: '/ov/aw.js', type: 'module' }]);
});

// The worker's script by its destination: sec-fetch-dest worker where the
// route sees it; Chromium shows the route none, and types it script.
test('by destination', async ({ page }) => {
  await page.route('**/ov/aw.js', (r) => {
    const q = r.request();
    const dest = q.headers()['sec-fetch-dest'];
    return (dest === undefined ? q.resourceType() === 'script' : dest === 'worker') ? r.continue(auth(r)) : r.continue();
  });
  await start(page, [{ url: '/ov/aw.js' }]);
});

test('once under no-referrer', async ({ page }) => {
  await page.route('**/ov/nw.js', (r) => r.continue(auth(r)), { times: 1 });
  await start(page, [{ url: '/ov/nw.js' }]);
});

test('once under no-referrer, module', async ({ page }) => {
  await page.route('**/ov/nw.js', (r) => r.continue(auth(r)), { times: 1 });
  await start(page, [{ url: '/ov/nw.js', type: 'module' }]);
});

test('once under origin, module', async ({ page }) => {
  await page.route('**/ov/gw.js', (r) => r.continue(auth(r)), { times: 1 });
  await start(page, [{ url: '/ov/gw.js', type: 'module' }]);
});

test('counted', async ({ page }) => {
  let n = 0;
  await page.route('**/ov/pw.js', (r) => {
    n += 1;
    return r.continue();
  });
  await start(page, [{ url: '/ov/pw.js' }, { url: '/ov/pw.js', type: 'module' }]);
  keep('counted-n', n);
});

// A Web Worker whose script the test's route answers itself, then a Shared
// Worker at the same address whose script it sends on with a header: each
// is named.
test('answered then continued at one address', async ({ page }) => {
  let n = 0;
  await page.route('**/ov/as.js', (r) => {
    n += 1;
    return n === 1 ? r.fulfill({ contentType: 'text/javascript', body: 'postMessage({ kind: \'own\' });' }) : r.continue(auth(r));
  });
  await start(page, [{ url: '/ov/as.js' }, { url: '/ov/as.js', shared: true }]);
});

// A page route that falls back with the browser's own headers, then a
// context route that adds the one the server needs: the last one's win.
test('two routes', async ({ context, page }) => {
  await context.route('**/ov/a*.js', (r) => r.continue(auth(r)));
  await page.route('**/ov/a*.js', (r) => r.fallback({ headers: r.request().headers() }));
  await start(page, [{ url: '/ov/aw.js' }, { url: '/ov/as.js', shared: true }]);
});

// A document under each referrer policy, set by a meta tag or by a header
// on the HTML only, starts a classic Web Worker at /ov/aw.js and a module
// one at /ov/tw.js, each sent on once with the header the server needs
// (times: 1), then a classic and a module one at /ov/pw.js, whose loads a
// route counts (kept as <title>-n).
for (const how of ['meta', 'header']) {
  for (const policy of ['no-referrer', 'origin', 'strict-origin']) {
    test(`doc ${how} ${policy}`, async ({ page }) => {
      let n = 0;
      await page.route('**/ov/aw.js', (r) => r.continue(auth(r)), { times: 1 });
      await page.route('**/ov/tw.js', (r) => r.continue(auth(r)), { times: 1 });
      await page.route('**/ov/pw.js', (r) => {
        n += 1;
        return r.continue();
      });
      await start(page, [{ url: '/ov/aw.js' }, { url: '/ov/tw.js', type: 'module' }, { url: '/ov/pw.js' }, { url: '/ov/pw.js', type: 'module' }], `/ovd/${how}/${policy}`);
      keep(`${test.info().title}-n`, n);
    });
  }
}

// A classic and a module Web Worker at /ov/ew.js throw after they start:
// kept is the filename and line the error event names in the worker (as
// the worker posts it) and in the page.
test('error event', async ({ page }) => {
  await page.goto(`${base}/ov`);
  const got: unknown[] = [];
  for (const type of ['classic', 'module'] as const) {
    got.push(await page.evaluate((t) => new Promise((resolve) => {
      const seen: Record<string, unknown> = {};
      const done = (): void => { if (seen.in !== undefined && seen.page !== undefined) resolve(seen); };
      const w = new Worker('/ov/ew.js', { type: t });
      w.onmessage = (e) => { seen.in = e.data; done(); };
      w.onerror = (e) => { seen.page = { filename: e.filename, lineno: e.lineno }; e.preventDefault(); done(); };
      setTimeout(() => resolve(seen), 10000);
    }), type));
  }
  keep(test.info().title, got);
});
