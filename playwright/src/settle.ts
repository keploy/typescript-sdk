// Settle: before a test's browser context closes, wait until none of the
// calls its pages made is in flight, so a call the test started is answered
// inside the test instead of being cut by the close (a call keploy recorded
// whole would be cut at a different byte each run). Counted by the
// browser's own request events; no time window decides it.

import type { BrowserContext, Frame, Page, Request } from '@playwright/test';
import { workerMark } from './random';

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
  // Chromium (stops): each frame's documents, the one it has now last; in
  // each, its script requests by URL (no fragment, no keploy mark), in the
  // order reported, and the places of the Web Workers there it terminated.
  private readonly docs = new Map<Frame, Doc[]>();
  // Each document's number (webWorkerDocument), the document it names.
  private readonly numbered = new Map<number, Doc>();
  private documents = 0;

  /**
   * stops: the browser reports no end for the script load of a Web Worker
   * terminated while its script loads (Chromium: no requestfinished or
   * requestfailed, ever), so settle drops that load when its document says
   * the worker was terminated (webWorkerStopped). Firefox and WebKit go on
   * loading it and report its end, which settle waits for.
   */
  constructor(context: BrowserContext, private readonly stops = false) {
    context.on('request', (r) => {
      if (this.ended.has(r)) return;
      let frame: Frame | null = null;
      // A service worker's call has no frame.
      try { frame = r.frame(); } catch { frame = null; }
      const nav = r.isNavigationRequest();
      if (!nav && (this.shared.get(frame)?.has(noFragment(r.url())) || sharedScript(r.url()))) return;
      if (this.stops && frame !== null && !nav && r.resourceType() === 'script' && this.loaded(frame, r)) return;
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
        // nothing. One with an answer is a new document: the Web Workers it
        // starts are its own (stops).
        if (this.stops && loading.has(f)) this.docs.get(f)?.push(newDoc());
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
      p.on('framedetached', (f) => {
        this.docs.delete(f);
        this.drop((o) => o.frame === f);
      });
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
   * (workersScript). Settle never waits on a request of that frame at
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

  /**
   * The document frame has now asks its number, which it gives with each Web
   * Worker it terminates (webWorkerStopped): a document that terminates one
   * after the frame committed the next (in its unload handler) names its
   * own. It asks as it starts, before any script of its own runs.
   */
  webWorkerDocument(frame: Frame | null): number {
    const n = ++this.documents;
    if (this.stops && frame !== null) this.numbered.set(n, this.docOf(frame));
    return n;
  }

  /**
   * The document numbered doc terminated the k-th Web Worker (from 1) it
   * started at url (no fragment): with stops, settle drops that worker's
   * script load (the k-th script request the document's frame reported at
   * that URL while the document was its own), now or when it is reported,
   * if keploy's route does not answer it (a URL keploy marked: answered
   * ends it). A load that ended, a URL the document started no Web Worker
   * at, or a place that is no whole number from 1 (no load is there),
   * drops nothing.
   */
  webWorkerStopped(doc: number, url: string, k: number): void {
    const d = this.numbered.get(doc);
    if (d === undefined) return;
    const u = noFragment(url);
    const at = loadsAt(d, u);
    at.stopped.add(k);
    const r = at.loads[k - 1];
    if (r !== undefined && workerMark(r.url()) === null) this.done(r);
  }

  // Keeps r, a script request of frame, in its document's loads: true when
  // it is the load of a Web Worker its document terminated already, which
  // settle never waits on.
  private loaded(frame: Frame, r: Request): boolean {
    const m = workerMark(r.url());
    // keploy's own loads (a seeding, a word of a worker) start no worker.
    if (m !== null && m.kind !== 'w' && m.kind !== 'm') return false;
    const at = loadsAt(this.docOf(frame), noFragment(m === null ? r.url() : m.url));
    at.loads.push(r);
    return m === null && at.stopped.has(at.loads.length);
  }

  private docOf(frame: Frame): Doc {
    let ds = this.docs.get(frame);
    if (ds === undefined) {
      ds = [newDoc()];
      this.docs.set(frame, ds);
    }
    return ds[ds.length - 1];
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

type Doc = Map<string, { loads: Request[]; stopped: Set<number> }>;

function newDoc(): Doc {
  return new Map();
}

function loadsAt(d: Doc, url: string): { loads: Request[]; stopped: Set<number> } {
  let at = d.get(url);
  if (at === undefined) {
    at = { loads: [], stopped: new Set() };
    d.set(url, at);
  }
  return at;
}

function pageOf(f: Frame): Page | null {
  try { return f.page(); } catch { return null; }
}

/**
 * Whether url carries keploy's mark for a Shared Worker's script (workerMark:
 * kind s or x). Settle never waits on such a request, whichever route
 * answers it: Chromium reports no end for it, as Playwright does not follow
 * Shared Workers.
 */
function sharedScript(url: string): boolean {
  const k = workerMark(url)?.kind;
  return k === 's' || k === 'x';
}

function noFragment(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

/**
 * The init script every keploy test's context runs, seeded or not, after
 * the seeding's (initScript), which calls the binding report (exposed on
 * the context, which this script takes off the window) with a kind first:
 * - the page's SharedWorker starts each worker as the app asked, then
 *   reports ('s', url) the script's URL, resolved against the document's
 *   base, with no fragment, so settle never waits on that script
 *   (Inflight.sharedWorker);
 * - the page's Worker starts each Web Worker as the app asked and numbers
 *   it k among the document's Web Workers at that URL (resolved, no
 *   fragment), from 1; at the document's first, it asks ('d') its number;
 *   its terminate() then reports ('t', number, url, k), once for each
 *   worker, so settle drops a script load the browser reports no end for
 *   (Inflight.webWorkerStopped).
 * A worker the browser refuses to start (a URL it cannot read) throws the
 * browser's own error and is neither reported nor numbered. Each keeps new,
 * instanceof, the constructor, name and length of the browser's own;
 * terminate keeps its name, length and the property's flags. The page's
 * own numbers are not drawn on.
 */
export function workersScript(report: string): string {
  const r = JSON.stringify(report);
  return `(() => {
  const g = globalThis;
  let tell = null;
  try { const f = g[${r}]; if (typeof f === 'function') tell = f; delete g[${r}]; } catch (e) { tell = null; }
  if (tell === null) return;
  const U = g.URL;
  const construct = Reflect.construct;
  const apply = Reflect.apply;
  const slice = Array.prototype.slice;
  const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); return p; };
  // The script's URL as the browser resolves it, with no fragment.
  const href = (url) => {
    const d = g.document;
    const u = new U(String(url), d ? d.baseURI : g.location.href);
    u.hash = '';
    return u.href;
  };
  // Puts a constructor in place of the browser's own at name, which calls
  // after with each worker it starts and the worker's script URL.
  const wrap = (name, after) => {
    const Real = g[name];
    if (typeof Real !== 'function') return null;
    const W = { [name]: function (url) {
      // Called without new, it throws as the browser's own does.
      if (!new.target) return apply(Real, this, arguments);
      const w = construct(Real, slice.call(arguments), new.target);
      try { after(w, href(url)); } catch (e) {}
      return w;
    } }[name];
    try {
      W.prototype = Real.prototype;
      Object.defineProperty(Real.prototype, 'constructor', { value: W, writable: true, enumerable: false, configurable: true });
      Object.setPrototypeOf(W, Object.getPrototypeOf(Real));
      const d = Object.getOwnPropertyDescriptor(g, name);
      Object.defineProperty(g, name, { value: W, writable: d ? d.writable : true, enumerable: d ? d.enumerable : false, configurable: true });
    } catch (e) {
      // A window that takes no property: its workers are as the browser's.
      return null;
    }
    return Real.prototype;
  };
  wrap('SharedWorker', (w, u) => { quiet(tell('s', u)); });
  // Each Web Worker's URL and place k there, until it is terminated.
  const places = new WeakMap();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const del = WeakMap.prototype.delete;
  const counts = Object.create(null);
  let doc = null;
  const P = wrap('Worker', (w, u) => {
    const k = (counts[u] || 0) + 1;
    counts[u] = k;
    apply(set, places, [w, [u, k]]);
    if (doc === null) doc = quiet(tell('d'));
  });
  const d = P ? Object.getOwnPropertyDescriptor(P, 'terminate') : undefined;
  if (!d || typeof d.value !== 'function') return;
  const stop = d.value;
  const T = { terminate: function () {
    const out = apply(stop, this, arguments);
    try {
      const at = apply(get, places, [this]);
      if (at !== undefined && doc !== null) {
        apply(del, places, [this]);
        doc.then((n) => { quiet(tell('t', n, at[0], at[1])); }, () => {});
      }
    } catch (e) {}
    return out;
  } }.terminate;
  try {
    Object.defineProperty(P, 'terminate', { value: T, writable: d.writable, enumerable: d.enumerable, configurable: true });
  } catch (e) {
    // A prototype that takes no property: its terminate is the browser's.
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

/**
 * The line a seeded test shows when keploy could not take its browser
 * context offline before Playwright closes it (closeOffline): why says what
 * setOffline threw.
 */
export function offlineLine(name: string, why: string): string {
  return `keploy: in ${name}, keploy could not take the test's browser context offline before it closes (${why}), ` +
    'so a request the browser starts as the context closes (a Web Worker\'s script load, or the load of its seeding) can reach the app\'s server ' +
    'with keploy\'s __keploy_worker mark in its URL; have the test wait for what its last step starts (a message a worker posts, or what the page shows from it) before it ends.';
}

/**
 * Takes a seeded test's browser context offline once keploy's end-of-test
 * wait is done, before the context closes (offlineBeforeClose). Firefox and WebKit
 * send a request that a page or a worker starts while its context closes to
 * the network past every route, keploy's too, so a worker's script load, or
 * the load of its seeding, that keploy marked would reach the app's server
 * with the mark in its URL; offline, the browser fails it instead. No test
 * step reads what such a request gets, and it is the same at record and at
 * replay. A context that cannot go offline (setOffline throws: the context
 * or its browser is gone, or this Playwright has none) closes anyway, and
 * the test says so through say.
 */
export async function closeOffline(context: { setOffline(offline: boolean): Promise<void> }, name: string, say: (line: string) => void): Promise<void> {
  try {
    await context.setOffline(true);
  } catch (e) {
    say(offlineLine(name, (e instanceof Error ? e.message : String(e)).split('\n')[0]));
  }
}

/** A browser as offlineBeforeClose needs it. */
export interface ClosingBrowser {
  close(options?: { reason?: string }): Promise<void>;
}

/** A browser context as offlineBeforeClose needs it. */
export interface Closing {
  setOffline(offline: boolean): Promise<void>;
  close(options?: { reason?: string }): Promise<void>;
  browser(): ClosingBrowser | null;
  on(event: 'close', listener: () => void): unknown;
}

// For each browser, the seeded contexts it has open: each goes offline
// before the browser closes.
const openOf = new WeakMap<ClosingBrowser, Set<() => Promise<void>>>();

/**
 * Has a seeded test's browser context go offline (closeOffline) before it
 * closes, whoever closes it: keploy's fixture once its end-of-test wait is
 * done (the function this returns), the test's own context.close(), or its
 * browser's close. Playwright skips a context's own teardown once the test's
 * time is spent, so when a test's timeout cut keploy's wait short the
 * context closes with its browser, as the worker ends. The context goes
 * offline once; a later call or close finds that done. A context that closed
 * (or that Playwright handed on for reuse) is no longer its browser's to
 * take offline.
 */
export function offlineBeforeClose(context: Closing, name: string, say: (line: string) => void): () => Promise<void> {
  let done: Promise<void> | null = null;
  const now = async (): Promise<void> => {
    done ??= closeOffline(context, name, say);
    await done;
  };
  const close = context.close;
  context.close = async (options?: { reason?: string }): Promise<void> => {
    await now();
    return close.call(context, options);
  };
  const browser = context.browser();
  if (browser !== null) {
    let open = openOf.get(browser);
    if (open === undefined) {
      const all = new Set<() => Promise<void>>();
      open = all;
      openOf.set(browser, all);
      const closeBrowser = browser.close;
      browser.close = async (options?: { reason?: string }): Promise<void> => {
        await Promise.all([...all].map((f) => f()));
        return closeBrowser.call(browser, options);
      };
    }
    const mine = open;
    mine.add(now);
    context.on('close', () => { mine.delete(now); });
  }
  return now;
}

/**
 * Whether Playwright keeps this browser context open for the next test
 * instead of closing it at the test's end (its reuseContext option, or
 * PW_TEST_REUSE_CONTEXT, which VS Code's Playwright extension sets for Show
 * browser). Playwright marks the context it hands out for reuse
 * (_forReuse); a Playwright without that flag is taken as reusing it when
 * PW_TEST_REUSE_CONTEXT is set.
 */
export function reusedContext(context: object, env: Record<string, string | undefined>): boolean {
  const f = (context as { _forReuse?: unknown })._forReuse;
  if (typeof f === 'boolean') return f;
  return (env.PW_TEST_REUSE_CONTEXT ?? '') !== '';
}

/**
 * The line a worker shows once, at its first seeded test in a browser
 * context Playwright reuses: keploy does not take such a context offline,
 * since Playwright's reset of it for the next test needs the network.
 */
export function reusedLine(name: string): string {
  return `keploy: in ${name}, Playwright keeps the test's browser context open for the next test (its reuseContext option, or PW_TEST_REUSE_CONTEXT, which VS Code's Show browser sets), ` +
    'so keploy does not take it offline as the test ends (Playwright\'s reset of it for the next test needs the network), ' +
    'and a request its pages or workers start after a test ends (a Web Worker\'s script load, or the load of its seeding) can reach the app\'s server ' +
    'with keploy\'s __keploy_worker mark in its URL; run keploy\'s tests without reuse (reuseContext: false, PW_TEST_REUSE_CONTEXT unset), ' +
    'or have each test wait for what its last step starts (a message a worker posts, or what the page shows from it) before it ends.';
}
