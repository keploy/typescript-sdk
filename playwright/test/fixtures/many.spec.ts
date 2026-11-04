import fs from 'node:fs';
import type { Frame, Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). A page that holds many
// frames of its origin, in its markup or put in by one script; sandboxed
// frames, which have no session storage; and what seeding costs a page
// whose DOM changes often. Each test keeps what it saw.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
const read = (): unknown => (window as unknown as { __draws: unknown }).__draws;

// /many's frames m0..m(k-1), once each has drawn: null for one that has
// not, or whose element holds no window.
async function frames(p: Page, k: number): Promise<unknown[]> {
  const look = (n: number): unknown[] => Array.from({ length: n }, (_, i) => {
    const w = (document.getElementsByName(`m${i}`)[0] as HTMLIFrameElement | undefined)?.contentWindow as unknown as { __draws?: unknown } | null;
    return w && w.__draws !== undefined ? JSON.parse(JSON.stringify(w.__draws)) : null;
  });
  let got: unknown[] = [];
  for (let i = 0; i < 1200; i++) {
    got = await p.evaluate(look, k);
    if (got.every((x) => x !== null)) return got;
    await p.waitForTimeout(50);
  }
  return got;
}

for (const how of ['markup', 'script']) {
  test(how, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/many?k=300&how=${how}`);
    const drew = await frames(page, 300);
    keep(how, { drew, errors });
  });
}

async function loaded(p: Page, n: string, path: string): Promise<Frame> {
  for (let i = 0; i < 400; i++) {
    const f = p.frame(n);
    if (f && new URL(f.url(), 'http://x').pathname === path) {
      try { if (await f.evaluate(() => (window as unknown as { __draws?: unknown }).__draws !== undefined)) return f; } catch { /* not yet */ }
    }
    await p.waitForTimeout(25);
  }
  throw new Error(`no frame ${n} at ${path}`);
}

test('sandboxed', async ({ page }) => {
  // Three sandboxed frames at one path, then a page with one.
  await page.goto(`${base}/sbx?n=3`);
  const two: Record<string, unknown> = {};
  for (const n of ['s0', 's1', 's2']) two[n] = await (await loaded(page, n, '/fs')).evaluate(read);
  await page.goto(`${base}/sbx?n=1`);
  keep('sandboxed', { two, one: await (await loaded(page, 's0', '/fs')).evaluate(read) });
});

// The page's time, in ms, for a workload: 'grow' adds 20000 rows in 500
// tasks; 'churn' adds and removes one span in each of 300 tasks, on a page
// of 20000 elements; 'shadow' does the same on a page of 2000 open shadow
// roots of 10 elements each.
const work = (kind: string): Promise<number> => new Promise((res) => {
  const box = document.getElementById('box')!;
  const mc = new MessageChannel();
  let i = 0;
  let last: Element | null = null;
  const T = kind === 'grow' ? 500 : 300;
  const t0 = performance.now();
  mc.port1.onmessage = () => {
    if (kind === 'grow') {
      for (let k = 0; k < 40; k++) { const d = document.createElement('div'); d.textContent = 'r'; box.appendChild(d); }
    } else {
      if (last) last.remove();
      last = document.createElement('span');
      box.appendChild(last);
    }
    if (++i < T) mc.port2.postMessage(0);
    else setTimeout(() => { res(performance.now() - t0); }, 0);
  };
  mc.port2.postMessage(0);
});

test('cost', async ({ page, browser }) => {
  // The same workloads in the test's page (seeded) and in a page of a
  // context the test made itself (not seeded), taken in turn; the least of
  // two runs each.
  const own = await browser.newContext();
  try {
    const mine = await own.newPage();
    const out: Record<string, { seeded: number; own: number }> = {};
    for (const [kind, at] of [['grow', '/cost?n=0'], ['churn', '/cost?n=20000'], ['shadow', '/cost?shadow=2000']]) {
      const t = { seeded: Infinity, own: Infinity };
      for (let r = 0; r < 2; r++) {
        for (const [which, p] of [['seeded', page], ['own', mine]] as const) {
          await p.goto(`${base}${at}`);
          t[which] = Math.min(t[which], await p.evaluate(work, kind));
        }
      }
      out[kind] = t;
    }
    keep('cost', out);
  } finally { await own.close(); }
});
