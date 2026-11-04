import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). Frames of a page's
// first document: one srcdoc, one about:blank with no src, then one the app
// puts where a removed frame was; a popup the first document opens with
// window.open('about:blank'); the test's own context init script, which
// draws in each document before keploy names the page; a frame in a shadow
// root; and a frame's Math.random drawn from once the frame is removed. Each
// test keeps what its pages drew.
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
  await p.goto(`${base}/draws`);
  keep('ownctxinit', { early, url: p.url() });
});

test('shadow', async ({ page }) => {
  // A frame inside a shadow root: whether its parent lists it among its
  // frames is the engine's.
  await page.setContent('<div id="h"></div>');
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.name = 'w';
    document.getElementById('h')!.attachShadow({ mode: 'open' }).appendChild(f);
  });
  const f = frame(page, 'w');
  const index = await f.evaluate(() => Array.from({ length: parent.length }, (_, j) => parent[j]).indexOf(window));
  keep('shadow', { index, draws: await f.evaluate(BLANK_DRAWS) });
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
