import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). Frames of a page's
// first document: two srcdoc (the first holding a frame of its own), one
// about:blank with no src, then one the app puts where that one was after
// removing it; a popup the first document opens with
// window.open('about:blank'); the test's own context init script, which
// draws in each document before keploy names the page; a frame in an open
// shadow root and one in a closed one; a frame's Math.random drawn from
// once the frame is removed; and top documents with no session storage.
// Each test keeps what its pages drew.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
// test/draws.mjs's BLANK_DRAWS: about:blank is no secure context, so it has
// no crypto.randomUUID.
const BLANK_DRAWS = '({ random: [Math.random(), Math.random()], bytes: Array.from(crypto.getRandomValues(new Uint8Array(8))) })';

const frame = (p: Page, name: string) => {
  const f = p.frame(name);
  if (!f) throw new Error(`no frame ${name} among ${p.frames().map((x) => x.name()).join(', ')}`);
  return f;
};

test('frames', async ({ page }) => {
  // n holds a frame of its own, nn.
  await page.setContent('<iframe name="n" srcdoc="<iframe name=nn></iframe>"></iframe><iframe name="s" srcdoc="<p>s</p>"></iframe><iframe name="b"></iframe>');
  await page.waitForLoadState('load');
  const drew: Record<string, unknown> = { top: await page.evaluate(BLANK_DRAWS) };
  for (const n of ['n', 'nn', 's', 'b']) drew[n] = { url: frame(page, n).url(), draws: await frame(page, n).evaluate(BLANK_DRAWS) };
  // The frame at b's index is removed, and another put in its place.
  await page.evaluate(() => {
    document.querySelector('iframe[name="b"]')!.remove();
    const c = document.createElement('iframe');
    c.name = 'c';
    document.body.appendChild(c);
  });
  drew.c = await frame(page, 'c').evaluate(BLANK_DRAWS);
  keep('frames', drew);
});

test('popupfromblank', async ({ page, context }) => {
  const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open('about:blank'); })]);
  keep('popupfromblank', { url: p.url(), draws: await p.evaluate(BLANK_DRAWS) });
});

test('ownctxinit', async ({ context }) => {
  await context.addInitScript('window.__early = Math.random();');
  const p = await context.newPage();
  const early = await p.evaluate(() => (window as unknown as { __early: number }).__early);
  // A popup its first document opens: at about:blank too, with another
  // reason (its opener has no place).
  const [q] = await Promise.all([context.waitForEvent('page'), p.evaluate(() => { window.open('about:blank'); })]);
  await q.waitForLoadState('load');
  await p.goto(`${base}/draws`);
  // A draw after the page's own scripts: the document drew its own first.
  const late = await p.evaluate(() => Math.random());
  keep('ownctxinit', { early, late, url: p.url() });
});

test('shadow', async ({ page }) => {
  // A frame inside an open shadow root, and one inside a closed one: no
  // engine lists either among its parent's frames.
  await page.setContent('<div id="h"></div><div id="k"></div>');
  await page.evaluate(() => {
    for (const [id, name, mode] of [['h', 'w', 'open'], ['k', 'v', 'closed']] as const) {
      const f = document.createElement('iframe');
      f.name = name;
      document.getElementById(id)!.attachShadow({ mode }).appendChild(f);
    }
  });
  const f = frame(page, 'w');
  const index = await f.evaluate(() => Array.from({ length: parent.length }, (_, j) => parent[j]).indexOf(window));
  keep('shadow', { index, open: await f.evaluate(BLANK_DRAWS), closed: await frame(page, 'v').evaluate(BLANK_DRAWS) });
});

test('nostorage', async ({ page }) => {
  // The page's first document draws; then, after a page of its origin,
  // about:blank loaded twice, a srcdoc frame of its origin in the first, a page
  // served with a CSP sandbox (/csp) loaded twice, and a data: URL loaded
  // twice: none has session storage.
  const drew: Record<string, unknown> = { first: await page.evaluate(BLANK_DRAWS), blank: [], csp: [], data: [] };
  await page.goto(`${base}/fa`);
  for (let i = 0; i < 2; i++) {
    await page.goto('about:blank');
    (drew.blank as unknown[]).push(await page.evaluate(BLANK_DRAWS));
    if (i === 0) {
      await page.evaluate(() => new Promise((done) => { const f = document.createElement('iframe'); f.name = 'in'; f.srcdoc = '<p>in</p>'; f.onload = done; document.body.appendChild(f); }));
      drew.inner = await frame(page, 'in').evaluate(BLANK_DRAWS);
    }
  }
  for (let i = 0; i < 2; i++) {
    await page.goto(`${base}/csp`);
    (drew.csp as unknown[]).push(await page.evaluate(() => (window as unknown as { __draws: unknown }).__draws));
  }
  for (let i = 0; i < 2; i++) {
    await page.goto('data:text/html,d');
    (drew.data as unknown[]).push(await page.evaluate(BLANK_DRAWS));
  }
  keep('nostorage', drew);
});

test('removed', async ({ page }) => {
  // Functions taken from a frame, then drawn from once it is removed.
  await page.setContent('<p>x</p>');
  const drew = await page.evaluate(() => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    const r = (f.contentWindow as unknown as { Math: Math }).Math.random;
    f.remove();
    return [r(), r()];
  });
  keep('removed', drew);
});
