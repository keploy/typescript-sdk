import fs from 'node:fs';
import { test } from '../../dist';

// A page's first document: in the page fixture's page, a draw before its
// first goto, then the page's own script in what setContent writes into that
// document; in one context.newPage() makes, setContent at once, then a draw. And a popup opened with noopener
// at an overlong address (DRAWS_BASE's /long/...), which keploy cannot place.
// Each test keeps what its pages drew.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
// test/draws.mjs's BLANK_DRAWS: about:blank is no secure context, so it has
// no crypto.randomUUID.
const BLANK_DRAWS = '({ random: [Math.random(), Math.random()], bytes: Array.from(crypto.getRandomValues(new Uint8Array(8))) })';

test('blank', async ({ page, context }) => {
  const set = `<script>window.__set = ${BLANK_DRAWS};</script>`;
  const read = (): unknown => (window as unknown as { __set: unknown }).__set;
  // Written by setContent as soon as newPage returns, then a draw after.
  const other = await context.newPage();
  await other.setContent(set);
  const drew: Record<string, unknown> = { other: { url: other.url(), set: await other.evaluate(read), after: await other.evaluate(BLANK_DRAWS) } };
  // A draw before the first goto, then setContent.
  const first = await page.evaluate(BLANK_DRAWS);
  await page.setContent(set);
  drew.page = { url: page.url(), first, set: await page.evaluate(read) };
  keep('blank', drew);
});

test('longpath', async ({ page, context }) => {
  await page.goto(`${base}/draws`);
  const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate((u) => { window.open(u, '_blank', 'noopener'); }, `${base}/long/${'x'.repeat(600)}`)]);
  await p.waitForLoadState('load');
  keep('longpath', { url: p.url() });
});
