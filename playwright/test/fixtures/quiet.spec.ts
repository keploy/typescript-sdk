import type { BrowserContext, Request } from '@playwright/test';
import { test } from '../../dist';

// The quiet rows' pages (rows.test.mjs, quietServer) each make a call after
// the test's last line has returned, as a single-page app's side panel loads
// on the page a test ended on.
const base = process.env.QUIET_BASE ?? '';
test('a call its page makes after an answer, once the body has ended', async ({ page }) => {
  await page.goto(`${base}/panel`);
});
test('a call its page makes after the test typed, once the body has ended', async ({ page }) => {
  await page.goto(`${base}/search`);
  await page.fill('input', 'lead');
});
test('the next test', async ({ page }) => {
  await page.goto(`${base}/blank`);
});
// Writes, as the test's context closes, the time from the end of its body,
// on the clock the wait's bound and cap are measured with: the wait lies between the two.
function sinceBody(context: BrowserContext): () => void {
  let end = 0;
  context.on('close', () => { process.stderr.write(`closed ${(performance.now() - end).toFixed(1)} ms after the body ended\n`); });
  return () => { end = performance.now(); };
}
test('a page that never goes quiet', async ({ page, context }) => {
  const ended = sinceBody(context);
  await page.goto(`${base}/polling`);
  ended();
});
test('a page that never goes quiet, and a call in flight', async ({ page }) => {
  await page.goto(`${base}/polling`);
  await page.evaluate(() => { void fetch('/hang'); });
});
test('a page whose calls overlap: it polls every 50 ms and never reads the answers', async ({ page, context }) => {
  const ended = sinceBody(context);
  await page.goto(`${base}/unread`);
  ended();
});
test('a call that never ends, begun while a slower call is waited for', async ({ page }) => {
  await page.goto(`${base}/chain`);
});
test('a call its page\'s own timer makes while a slow call is in flight', async ({ page }) => {
  await page.goto(`${base}/timer`);
});
test('a poller that calls again 100 ms after each answer', async ({ page, context }) => {
  const ended = sinceBody(context);
  await page.goto(`${base}/chained`);
  ended();
});
// About 1 s into the settle wait, this process's event loop is held 800 ms,
// as a loaded machine holds it, while the page goes on calling. The hold
// starts on the loop's next turn after a call's end, with no call in flight
// (else after a later end): the end has restarted the 500 ms, which then
// passes during the hold, and the calls the page makes in the hold wait
// unread until the timers have run. The calls are counted from before the
// page's first, so a call in flight when the body ends is counted too.
test('a page that never goes quiet, its test process held in the wait', async ({ page, context }) => {
  const open = new Set<Request>();
  let from = Infinity;
  let held = false;
  context.on('request', (r) => { open.add(r); });
  context.on('requestfailed', (r) => { open.delete(r); });
  context.on('requestfinished', (r) => {
    open.delete(r);
    if (held || performance.now() - from < 1000) return;
    held = true;
    setImmediate(() => {
      if (open.size > 0) { held = false; return; }
      process.stderr.write('held 800 ms\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    });
  });
  await page.goto(`${base}/polling`);
  from = performance.now();
});
