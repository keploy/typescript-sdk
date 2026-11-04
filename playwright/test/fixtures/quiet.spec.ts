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
test('a page that never goes quiet', async ({ page }) => {
  await page.goto(`${base}/polling`);
});
test('a page that never goes quiet, and a call in flight', async ({ page }) => {
  await page.goto(`${base}/polling`);
  await page.evaluate(() => { void fetch('/hang'); });
});
test('a call that never ends, begun while a slower call is waited for', async ({ page }) => {
  await page.goto(`${base}/chain`);
});
test('a call its page\'s own timer makes while a slow call is in flight', async ({ page }) => {
  await page.goto(`${base}/timer`);
});
test('a poller that calls again 100 ms after each answer', async ({ page }) => {
  await page.goto(`${base}/chained`);
});
