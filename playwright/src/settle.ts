// Settle: before a test's browser context closes, wait until none of the
// calls its pages made is in flight, so a call the test started is answered
// inside the test instead of being cut by the close (a call keploy recorded
// whole would be cut at a different byte each run). Counted by the
// browser's own request events; no time window decides it.

import type { BrowserContext, Frame, Page, Request } from '@playwright/test';

export class Inflight {
  // Each call's number, in the order the browser reported it.
  private readonly open = new Map<Request, { frame: Frame | null; nav: boolean; n: number }>();
  private reported = 0;
  private waiters: (() => void)[] = [];
  // The calls keploy's own route answered whole (answered).
  private readonly ended = new WeakSet<Request>();

  constructor(context: BrowserContext) {
    context.on('request', (r) => {
      if (this.ended.has(r)) return;
      let frame: Frame | null = null;
      // A service worker's call has no frame.
      try { frame = r.frame(); } catch { frame = null; }
      this.open.set(r, { frame, nav: r.isNavigationRequest(), n: ++this.reported });
    });
    context.on('requestfinished', (r) => this.done(r));
    context.on('requestfailed', (r) => this.done(r));
    // The frames whose navigation request was answered with a document, which
    // the frame commits next, each with the number of the last call reported
    // before that answer: the new document can make no call before its
    // answer, so every later one may be its own (a redirect's answer is not
    // the document's, and the final answer's number replaces it).
    const loading = new Map<Frame, number>();
    context.on('response', (res) => {
      const r = res.request();
      if (!r.isNavigationRequest()) return;
      let f: Frame | null = null;
      try { f = r.frame(); } catch { f = null; }
      // A 204 or 205 answer, or a download, leaves the document in place.
      const keeps = res.status() === 204 || res.status() === 205 || /attachment/i.test(res.headers()['content-disposition'] ?? '');
      if (f && !keeps) loading.set(f, this.reported);
    });
    const watch = (p: Page): void => {
      // The browser reports no end for a call whose document was replaced
      // while it ran: a frame that commits a new document has cancelled
      // every call the old one still had open. Only the calls reported
      // before the new document's answer are surely the old one's: Firefox
      // can report a call the new document makes as it loads (a script or
      // an image its parser asks for) before it reports the commit, and
      // that call is waited for. A call the old document starts after its
      // replacement's answer (an unload handler's) is waited for too: the
      // browser tells the two apart by nothing settle sees, and waiting
      // fails toward the test's timeout, never toward a cut call. A
      // navigation inside the document (the history API, a client-side
      // route change) has no navigation request and replaces nothing.
      p.on('framenavigated', (f) => {
        // A commit with no answer (a route change) is numbered 0: it drops
        // nothing.
        const answered = loading.get(f) ?? 0;
        loading.delete(f);
        this.drop((o) => o.frame === f && !o.nav && o.n <= answered);
      });
      // Nor for the calls of a page that closes. Only that page's calls: a
      // popup that closes cancels nothing of its opener.
      p.on('close', () => this.drop((o) => o.frame !== null && pageOf(o.frame) === p));
      // Nor for the calls of a frame that is gone: removed, or gone with
      // the document it was in when the page loaded another (a payment
      // form's frame). Playwright reports no end for the calls such a frame
      // still had in flight when it went with the page's old document:
      // ordinary, keepalive (navigator.sendBeacon, fetch with keepalive,
      // which the browser goes on sending only until the test closes its
      // context), or the frame's own document request, still loading. Each
      // frame that goes is reported apart, a frame inside it too.
      p.on('framedetached', (f) => this.drop((o) => o.frame === f));
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    // Nor for any call when the test closes its own context, which ends its
    // service workers too. A service worker's call has no frame, so no
    // page's close drops it; this is the only rule that does.
    context.on('close', () => this.drop(() => true));
  }

  /** The calls still in flight, for a step's title. */
  describe(): string[] {
    return [...this.open.keys()].map((r) => `${r.method()} ${r.url()}`);
  }

  get size(): number {
    return this.open.size;
  }

  /** Resolves once no call is in flight. */
  settled(): Promise<void> {
    if (this.open.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * A call keploy's own route answered whole (a worker's script): nothing of
   * it is in flight, whatever the browser reports after. Chromium reports
   * no end for a Shared Worker's script: Playwright does not follow Shared
   * Workers, and the end goes to the worker.
   */
  answered(r: Request): void {
    this.ended.add(r);
    this.done(r);
  }

  private done(r: Request): void {
    if (this.open.delete(r)) this.wake();
  }

  private drop(gone: (o: { frame: Frame | null; nav: boolean; n: number }) => boolean): void {
    let n = 0;
    for (const [r, o] of this.open) {
      if (gone(o)) { this.open.delete(r); n++; }
    }
    if (n > 0) this.wake();
  }

  private wake(): void {
    if (this.open.size !== 0) return;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
}

function pageOf(f: Frame): Page | null {
  try { return f.page(); } catch { return null; }
}
