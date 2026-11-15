import fs from 'node:fs';
import type { Route } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER), seeded and with seeding
// off. A route of the test's own page takes itself off as it gets a Web
// Worker's script load (the page's last route: unroute, or unrouteAll with
// a behavior), then answers the load: Playwright sends the load on as the
// page has no route left, so a continue, fulfill or abort after that fails
// ('Route is already handled!'; after 'ignoreErrors' the error is dropped)
// and a fallback does nothing more. unrouteAll's 'wait' from the test,
// while the route holds the load, waits for the route, whose continue
// sends it. The worker's message (its kind, location and draws) is kept
// under the test's title.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

test.use({ serviceWorkers: 'block' });

const work = (): Promise<unknown> => new Promise((resolve) => {
  const w = new Worker('/ov/pw.js');
  w.onmessage = (e) => resolve(e.data);
  w.onerror = () => resolve('error');
});

for (const how of ['continue', 'fallback'] as const) {
  test(`unroute then ${how}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    const h = async (r: Route): Promise<void> => {
      await page.unroute('**/ov/pw.js', h);
      await (how === 'continue' ? r.continue() : r.fallback());
    };
    await page.route('**/ov/pw.js', h);
    keep(test.info().title, await page.evaluate(() => new Promise((resolve) => {
      const w = new Worker('/ov/pw.js');
      w.onmessage = (e) => resolve(e.data);
      w.onerror = () => resolve('error');
    })));
  });
}

for (const [behavior, how] of [['default', 'fulfill'], ['ignoreErrors', 'abort']] as const) {
  test(`unrouteAll ${behavior} then ${how}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    await page.route('**/ov/pw.js', async (r: Route): Promise<void> => {
      await page.unrouteAll({ behavior });
      await (how === 'fulfill' ? r.fulfill({ contentType: 'text/javascript', body: 'postMessage("own")' }) : r.abort());
    });
    keep(test.info().title, await page.evaluate(work));
  });
}

test('unrouteAll wait then continue', async ({ page }) => {
  await page.goto(`${base}/ov`);
  let reached = (): void => {};
  const at = new Promise<void>((resolve) => { reached = resolve; });
  let go = (): void => {};
  const going = new Promise<void>((resolve) => { go = resolve; });
  await page.route('**/ov/pw.js', async (r: Route): Promise<void> => {
    reached();
    await going;
    await r.continue();
  });
  const done = page.evaluate(work);
  await at;
  const off = page.unrouteAll({ behavior: 'wait' });
  go();
  await off;
  keep(test.info().title, await done);
});
