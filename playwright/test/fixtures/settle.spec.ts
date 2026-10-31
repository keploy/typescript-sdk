import { test } from '../../dist';

const base = process.env.SLOW_BASE ?? '';
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
  await page.goto(`${base}/page?next`);
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
