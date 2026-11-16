import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// Run in Chromium, Firefox and WebKit (PW_BROWSER), seeded and with seeding
// off. Each test starts, from the page at /sv, workers whose scripts the
// server serves in a way of its own (a charset, a Content-Security-Policy,
// a redirect), one at a time, and keeps what each sent (its kind, draws and
// location, and what it read), or 'error' or 'none', under its title.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

test.use({ serviceWorkers: 'block' });

type Start = { url: string; type?: 'classic' | 'module'; shared?: boolean };
const start = async (page: Page, list: Start[]): Promise<void> => {
  await page.goto(`${base}/sv`);
  const got: unknown[] = [];
  for (const s of list) {
    got.push(await page.evaluate((x) => new Promise((resolve) => {
      setTimeout(() => resolve('none'), 10000);
      if (x.shared) {
        const w = new SharedWorker(x.url, { type: x.type ?? 'classic' });
        w.port.onmessage = (e) => resolve(e.data);
        w.onerror = () => resolve('error');
        return;
      }
      const w = new Worker(x.url, { type: x.type ?? 'classic' });
      w.onmessage = (e) => resolve(e.data);
      w.onerror = () => resolve('error');
    }), s));
  }
  keep(test.info().title, got);
};

test('latin1', async ({ page }) => start(page, [{ url: '/sv/l1.js' }, { url: '/sv/l1.js', type: 'module' }]));
test('csp', async ({ page }) => start(page, [{ url: '/sv/cn.js' }, { url: '/sv/csn.js' }, { url: '/sv/ctt.js' }, { url: '/sv/cn.js', type: 'module' }, { url: '/sv/cn.js', type: 'module' }]));
test('redirect', async ({ page }) => start(page, [{ url: '/rd/w.js' }, { url: '/rdm/m.js', type: 'module' }, { url: '/rds/s.js', shared: true }, { url: '/rd/w.js' }]));
// Under a Content-Security-Policy of the script's own: module Web Workers
// that import a module drawing as it loads (default-src 'self', helmet's
// default), a module and a classic one under 'strict-dynamic', and a
// classic and a module Shared Worker under default-src 'none'.
test('own', async ({ page }) => start(page, [{ url: '/mc/s.js', type: 'module' }, { url: '/mc/h.js', type: 'module' }, { url: '/mc/sd.js', type: 'module' }, { url: '/mc/sdc.js' }, { url: '/sv/sn.js', shared: true }, { url: '/sv/snm.js', type: 'module', shared: true }]));
