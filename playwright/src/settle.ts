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
  // The script URLs, with no fragment, that each frame started a Shared
  // Worker at, for the test's life (sharedWorker).
  private readonly shared = new Map<Frame | null, Set<string>>();

  constructor(context: BrowserContext) {
    context.on('request', (r) => {
      if (this.ended.has(r)) return;
      let frame: Frame | null = null;
      // A service worker's call has no frame.
      try { frame = r.frame(); } catch { frame = null; }
      const nav = r.isNavigationRequest();
      if (!nav && this.shared.get(frame)?.has(noFragment(r.url()))) return;
      this.open.set(r, { frame, nav, n: ++this.reported });
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

  /**
   * A document of frame started a Shared Worker whose script is at url
   * (sharedWorkerScript). Settle never waits on a request of that frame at
   * that URL (fragment aside) that is no navigation, reported before this or
   * after, for the rest of the test: the worker's script is one, and Chromium
   * reports no end for it, as Playwright does not follow Shared Workers. The
   * test's line (sharedWorkerLine) names the URL.
   */
  sharedWorker(frame: Frame | null, url: string): void {
    const u = noFragment(url);
    let s = this.shared.get(frame);
    if (s === undefined) {
      s = new Set();
      this.shared.set(frame, s);
    }
    s.add(u);
    this.drop((o, r) => !o.nav && o.frame === frame && noFragment(r.url()) === u);
  }

  private done(r: Request): void {
    if (this.open.delete(r)) this.wake();
  }

  private drop(gone: (o: { frame: Frame | null; nav: boolean; n: number }, r: Request) => boolean): void {
    let n = 0;
    for (const [r, o] of this.open) {
      if (gone(o, r)) { this.open.delete(r); n++; }
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

function noFragment(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

/**
 * The init script every keploy test's context runs, seeded or not, after
 * the seeding's (initScript): the page's SharedWorker, which starts each
 * worker as the app asked, with the same arguments, then calls the binding
 * report (exposed on the context, which this script takes off the window)
 * with the script's URL, resolved against the document's base, with no
 * fragment, so settle never waits on that script (Inflight.sharedWorker).
 * A worker the browser refuses to start (a URL it cannot read) throws the
 * browser's own error and reports nothing. It keeps new, instanceof, the
 * constructor, name and length of the browser's own.
 */
export function sharedWorkerScript(report: string): string {
  const r = JSON.stringify(report);
  return `(() => {
  const g = globalThis;
  let tell = null;
  try { const f = g[${r}]; if (typeof f === 'function') tell = f; delete g[${r}]; } catch (e) { tell = null; }
  const Real = g.SharedWorker;
  if (typeof Real !== 'function' || tell === null) return;
  const U = g.URL;
  const construct = Reflect.construct;
  const slice = Array.prototype.slice;
  const W = { SharedWorker: function (url) {
    // Called without new, it throws as the browser's own does.
    if (!new.target) return Real.apply(this, arguments);
    const w = construct(Real, slice.call(arguments), new.target);
    try {
      const d = g.document;
      const u = new U(String(url), d ? d.baseURI : g.location.href);
      u.hash = '';
      const p = tell(u.href);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
    return w;
  } }.SharedWorker;
  try {
    W.prototype = Real.prototype;
    Object.defineProperty(Real.prototype, 'constructor', { value: W, writable: true, enumerable: false, configurable: true });
    Object.setPrototypeOf(W, Object.getPrototypeOf(Real));
    const d = Object.getOwnPropertyDescriptor(g, 'SharedWorker');
    Object.defineProperty(g, 'SharedWorker', { value: W, writable: d ? d.writable : true, enumerable: d ? d.enumerable : false, configurable: true });
  } catch (e) {
    // A window that takes no property: its Shared Workers are as the browser's.
  }
})();
`;
}

/**
 * The line a test shows, once for each Shared Worker script address (at,
 * origin and path), when one of its pages started a Shared Worker.
 */
export function sharedWorkerLine(name: string, at: string): string {
  return `keploy: in ${name}, a page started the Shared Worker at ${at}: keploy does not wait for its script or its calls before the test's browser context closes ` +
    '(Playwright reports none of a Shared Worker\'s calls), so a call it still has in flight when the test ends is cut there; ' +
    'have the test wait for what the worker does (a message it posts, or what the page shows from it) before it ends.';
}
