import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test } from '../../dist';

// service.spec.ts's and service-blocked.spec.ts's run, in Chromium, Firefox
// and WebKit (PW_BROWSER). The page at /sw registers the Service Worker
// /sw.js, waits until it controls the page (when the browser registered
// it), and starts the Web Worker /swk/w.js and the Shared Worker /swk/s.js;
// each sends what it drew and its location. The Service Worker then sends
// the URL of each request it was asked. The test keeps them, under its title.
const base = process.env.DRAWS_BASE ?? '';
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));

type Took = { __w: { kind: string }[] };

export async function serviceRun(page: Page): Promise<void> {
  await page.goto(`${base}/sw`);
  await page.waitForFunction(() => (window as unknown as Took).__w.filter((m) => m.kind === 'sw-ded' || m.kind === 'sw-shared').length >= 2, null, { timeout: 20000 });
  const seen = await page.evaluate(() => {
    const c = navigator.serviceWorker;
    if (!c || !c.controller) return null;
    const asked = c.controller;
    return new Promise((ok) => {
      c.addEventListener('message', (e) => ok(e.data), { once: true });
      asked.postMessage('seen');
    });
  });
  keep(test.info().title, { w: await page.evaluate(() => (window as unknown as Took).__w), seen });
}
