import fs from 'node:fs';
import type { Frame, Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER). A page that holds many
// frames of its origin, in its markup or put in by one script; sandboxed
// frames, which have no session storage (some whose own script replaces the
// global parent, some holding a srcdoc frame); and what seeding costs a page
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
  const three: Record<string, unknown> = {};
  for (const n of ['s0', 's1', 's2']) three[n] = await (await loaded(page, n, '/fs')).evaluate(read);
  await page.goto(`${base}/sbx?n=1`);
  keep('sandboxed', { three, one: await (await loaded(page, 's0', '/fs')).evaluate(read) });
});

test('lone', async ({ page }) => {
  // A lone sandboxed frame, then taken out, and another put in at its path.
  await page.goto(`${base}/sbx?n=1`);
  const first = await (await loaded(page, 's0', '/fs')).evaluate(read);
  await page.evaluate(() => {
    document.getElementsByName('s0')[0].remove();
    const f = document.createElement('iframe');
    f.name = 'r0';
    f.setAttribute('sandbox', 'allow-scripts');
    f.src = '/fs';
    document.body.appendChild(f);
  });
  keep('lone', { first, again: await (await loaded(page, 'r0', '/fs')).evaluate(read) });
});

test('swapped', async ({ page }) => {
  // Nine sandboxed frames, three at each of /fsv, /fss and /fso, whose own
  // script replaces the global parent before it draws.
  await page.goto(`${base}/sbx?n=3&swap=1`);
  const drew: Record<string, unknown> = {};
  for (const [k, path] of [['v', '/fsv'], ['s', '/fss'], ['o', '/fso']]) {
    for (let i = 0; i < 3; i++) drew[`${k}${i}`] = await (await loaded(page, `${k}${i}`, path)).evaluate(read);
  }
  keep('swapped', drew);
});

test('held', async ({ page }) => {
  // Three sandboxed frames at /fh: the parent's parser puts in the second
  // and third only once the first has drawn and loaded.
  await page.goto(`${base}/held`);
  const drew: Record<string, unknown> = {};
  for (const n of ['h0', 'h1', 'h2']) drew[n] = await (await loaded(page, n, '/fh')).evaluate(read);
  keep('held', drew);
});

test('nested', async ({ page }) => {
  // Two sandboxed frames at /fsn, each holding a srcdoc frame of its origin.
  await page.goto(`${base}/sbx?n=2&nest=1`);
  const drew: Record<string, { own: unknown; child: unknown }> = {};
  for (const n of ['s0', 's1']) {
    const f = await loaded(page, n, '/fsn');
    let child: unknown;
    for (let i = 0; i < 400 && child === undefined; i++) {
      const c = f.childFrames()[0];
      if (c) { try { child = await c.evaluate(() => (window as unknown as { __draws?: unknown }).__draws); } catch { /* not yet */ } }
      if (child === undefined) await page.waitForTimeout(25);
    }
    if (child === undefined) throw new Error(`no srcdoc frame drew in ${n}`);
    drew[n] = { own: await f.evaluate(read), child };
  }
  keep('nested', drew);
});

// A workload in the page: 'grow' adds 20000 rows in 500 tasks; 'churn'
// adds and removes one span in each of 300 tasks, on a page of 20000
// elements; 'shadow' does the same on a page of 2000 open shadow roots of
// 10 elements each. It answers its time in ms, and how many times the
// seeding walked the document (a querySelectorAll('*') on it) during the
// workload, and then after one frame is put in.
const work = (kind: string): Promise<{ ms: number; walks: number; framed: number }> => new Promise((res) => {
  let walks = 0;
  const all = Document.prototype.querySelectorAll;
  Document.prototype.querySelectorAll = function (this: Document, q: string) {
    if (q === '*' && this === document) walks++;
    return all.call(this, q);
  } as typeof all;
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
    if (++i < T) { mc.port2.postMessage(0); return; }
    setTimeout(() => {
      const ms = performance.now() - t0;
      const during = walks;
      box.appendChild(document.createElement('iframe'));
      setTimeout(() => { Document.prototype.querySelectorAll = all; res({ ms, walks: during, framed: walks - during }); }, 0);
    }, 0);
  };
  mc.port2.postMessage(0);
});

test('cost', async ({ page, browser }) => {
  // The same workloads in the test's page (seeded) and in a page of a
  // context the test made itself (not seeded), taken in turn; the least
  // time of two runs each, and the walks of the seeded page's runs.
  // WebKit takes 3 to 6 s for one 'grow' run, seeded or not, so on a
  // busy machine the twelve runs (four of them 'grow') can take more
  // than the 30 s a test gets by default.
  test.setTimeout(120_000);
  const own = await browser.newContext();
  try {
    const mine = await own.newPage();
    const out: Record<string, { seeded: number; own: number; walks: number[]; framed: number[]; ownWalks: number[] }> = {};
    for (const [kind, at] of [['grow', '/cost?n=0'], ['churn', '/cost?n=20000'], ['shadow', '/cost?shadow=2000']]) {
      const t = { seeded: Infinity, own: Infinity, walks: [] as number[], framed: [] as number[], ownWalks: [] as number[] };
      for (let r = 0; r < 2; r++) {
        for (const [which, p] of [['seeded', page], ['own', mine]] as const) {
          await p.goto(`${base}${at}`);
          const got = await p.evaluate(work, kind);
          t[which] = Math.min(t[which], got.ms);
          if (which === 'seeded') { t.walks.push(got.walks); t.framed.push(got.framed); } else t.ownWalks.push(got.walks + got.framed);
        }
      }
      out[kind] = t;
    }
    keep('cost', out);
  } finally { await own.close(); }
});
