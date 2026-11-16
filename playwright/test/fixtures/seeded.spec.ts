import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// DRAWS_BASE serves /draws, a page whose first script draws random numbers as
// it loads, and which holds a cross-site frame (/frame on another host of
// the same server) that does the same. Each test keeps what its pages drew.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

async function load(page: Page, query = ''): Promise<{ top: unknown; frame: unknown }> {
  await page.goto(`${base}/draws${query}`);
  const frame = page.frames().find((f) => f.url().endsWith('/frame'));
  if (!frame) throw new Error(`no /frame among ${page.frames().map((f) => f.url()).join(', ')}`);
  const read = (): unknown => (window as unknown as { __draws: unknown }).__draws;
  return { top: await page.evaluate(read), frame: await frame.evaluate(read) };
}

test('one', async ({ page }) => {
  keep('one', await load(page));
  // Each seeded function, called with a this that is no Crypto.
  keep('this', await page.evaluate(() => {
    const thrown = (f: () => unknown): string => { try { f(); return 'no error'; } catch (e) { return String(e); } };
    return {
      grv: thrown(() => crypto.getRandomValues.call({}, new Uint8Array(4))),
      uuid: thrown(() => crypto.randomUUID.call({})),
      drew: crypto.getRandomValues(new Uint8Array(4)).some((x) => x !== 0) || crypto.randomUUID().length === 36,
    };
  }));
});
test('two', async ({ page }) => { keep('two', await load(page)); });
test('again', async ({ page }) => {
  // The same page loaded again, then with a query: the path and its count
  // name the document, the query does not.
  keep('again', [await load(page), await load(page), await load(page, '?t=' + Date.now())]);
});
test.describe('own', () => {
  test.use({ keploySeedRandom: false });
  test('three', async ({ page }) => { keep('three', await load(page)); });
});
