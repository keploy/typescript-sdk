import type { Route } from '@playwright/test';
import { test } from '../../dist';

// Run seeded in Chromium, Firefox and WebKit (PW_BROWSER), each test
// TEARDOWN_COPIES times (default 1), with several runs at once: a test whose
// last step starts a worker and returns, and one whose page route takes
// itself off and then fulfills a Web Worker's script load, so the test ends
// and its browser context closes while the worker's script load, or the load
// of the seeding keploy's answer makes, is on its way; and one that closes
// its own browser context as a worker starts. Firefox and WebKit
// send a request started as the context closes past every route; the app's
// server must never see keploy's mark.
const base = process.env.DRAWS_BASE ?? '';
const copies = Number(process.env.TEARDOWN_COPIES || 1);

test.use({ serviceWorkers: 'block' });

for (let i = 0; i < copies; i++) {
  test(`classic worker as the test ends ${i}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    await page.evaluate(() => { new Worker('/ov/pw.js'); });
  });

  test(`module worker as the test ends ${i}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    await page.evaluate(() => { new Worker('/ov/pw.js', { type: 'module' }); });
  });

  test(`classic worker started in a timer as the test ends ${i}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    await page.evaluate(() => { setTimeout(() => { new Worker('/ov/pw.js'); }, 0); });
  });

  test(`classic worker as the test closes its context ${i}`, async ({ context, page }) => {
    await page.goto(`${base}/ov`);
    await page.evaluate(() => { new Worker('/ov/pw.js'); });
    await context.close();
  });

  test(`shared worker as the test ends ${i}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    await page.evaluate(() => { new SharedWorker('/ov/ps.js'); });
  });

  test(`unrouteAll default then fulfill ${i}`, async ({ page }) => {
    await page.goto(`${base}/ov`);
    await page.route('**/ov/pw.js', async (r: Route): Promise<void> => {
      await page.unrouteAll({ behavior: 'default' });
      await r.fulfill({ contentType: 'text/javascript', body: 'postMessage("own")' });
    });
    await page.evaluate(() => new Promise((resolve) => {
      const w = new Worker('/ov/pw.js');
      w.onmessage = (e) => resolve(e.data);
      w.onerror = () => resolve('error');
    }));
  });
}
