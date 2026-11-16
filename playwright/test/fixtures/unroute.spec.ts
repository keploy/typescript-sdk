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
// under the test's title. Each test ends only once its worker's message
// has come and its route's answer has ended, and one that fails by its
// route's error throws it then (the route keeps it; after 'ignoreErrors'
// Playwright drops it), so no test ends while its worker still loads: a
// load the browser starts as Playwright closes a seeded test's context can
// reach the server with keploy's mark (the README's "What the run says
// when ...").
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

test.use({ serviceWorkers: 'block' });

const work = (): Promise<unknown> => new Promise((resolve) => {
  const w = new Worker('/ov/pw.js');
  w.onmessage = (e) => resolve(e.data);
  w.onerror = () => resolve('error');
});

// A route's answer: run(answer, keepIt) runs it and, with keepIt, keeps
// what it throws instead of throwing it; after() waits until the answer
// has ended, then throws what was kept.
const routeAnswer = (): { run: (answer: () => Promise<void>, keepIt: boolean) => Promise<void>; after: () => Promise<void> } => {
  let err: { e: unknown } | null = null;
  let ended = (): void => {};
  const end = new Promise<void>((resolve) => { ended = resolve; });
  return {
    run: async (answer, keepIt) => {
      try {
        await answer();
      } catch (e) {
        if (!keepIt) throw e;
        err = { e };
      } finally {
        ended();
      }
    },
    after: async () => {
      await end;
      if (err !== null) throw err.e;
    },
  };
};

for (const how of ['continue', 'fallback'] as const) {
  test(`unroute then ${how}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    const answered = routeAnswer();
    const h = async (r: Route): Promise<void> => {
      await page.unroute('**/ov/pw.js', h);
      await answered.run(() => (how === 'continue' ? r.continue() : r.fallback()), true);
    };
    await page.route('**/ov/pw.js', h);
    keep(test.info().title, await page.evaluate(work));
    await answered.after();
  });
}

for (const [behavior, how] of [['default', 'fulfill'], ['ignoreErrors', 'abort']] as const) {
  test(`unrouteAll ${behavior} then ${how}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    const answered = routeAnswer();
    await page.route('**/ov/pw.js', async (r: Route): Promise<void> => {
      await page.unrouteAll({ behavior });
      // After 'ignoreErrors', Playwright drops the route's error itself.
      await answered.run(() => (how === 'fulfill' ? r.fulfill({ contentType: 'text/javascript', body: 'postMessage("own")' }) : r.abort()), behavior === 'default');
    });
    keep(test.info().title, await page.evaluate(work));
    await answered.after();
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
