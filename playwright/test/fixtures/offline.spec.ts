import type { BrowserContext, Page } from '@playwright/test';
import fs from 'node:fs';
import { test } from '../../dist';

// Run seeded and with seeding off. The context of a test whose
// setOffline throws, or that has none, cannot go offline before it closes.
// A test that puts back the context's own close, past keploy's, keeps
// whether its page reaches the app's server as Playwright closes it.
// The 'reused' tests run with PW_TEST_REUSE_CONTEXT=1 alone (-g reused):
// Playwright then keeps one browser context for the tests that ask the same
// options and does not close it between them. Each such test keeps whether
// its page loads the app's page (online or offline) and its context's id
// under its title.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
const reach = (page: Page): Promise<string> => page.goto(`${base}/ov`).then(() => 'online', () => 'offline');
const id = (context: BrowserContext): unknown => (context as unknown as { _guid?: string })._guid;

test.use({ serviceWorkers: 'block' });

test('a context whose setOffline throws', async ({ context, page }) => {
  await page.goto(`${base}/ov`);
  (context as unknown as { setOffline: () => Promise<void> }).setOffline = async () => { throw new Error('no offline here\nand a second line'); };
});

test('a context with no setOffline', async ({ context, page }) => {
  await page.goto(`${base}/ov`);
  (context as unknown as { setOffline?: unknown }).setOffline = undefined;
});

test('a context whose close keploy did not wrap', async ({ context, page }) => {
  await page.goto(`${base}/ov`);
  const close = (Object.getPrototypeOf(context) as { close: (o?: { reason?: string }) => Promise<void> }).close;
  context.close = async function (this: BrowserContext, o?: { reason?: string }): Promise<void> {
    keep('at close', await page.evaluate(() => fetch('/ov?at-close').then(() => 'online', () => 'offline')));
    return close.call(this, o);
  };
});

test.describe('reused', () => {
  test('online one', async ({ context, page }) => { keep(test.info().title, [await reach(page), id(context)]); });
  test('online two', async ({ context, page }) => { keep(test.info().title, [await reach(page), id(context)]); });
  test('online three', async ({ context, page }) => { keep(test.info().title, [await reach(page), id(context)]); });
});
