// Settle: before a test's browser context closes, wait until none of the
// calls its pages made is in flight, so a call the test started is answered
// inside the test instead of being cut by the close (a call keploy recorded
// whole would be cut at a different byte each run). Counted by the
// browser's own request events; no time window decides it.

import type { BrowserContext, Frame, Page, Request, Route } from '@playwright/test';
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
  // Chromium (stops): the script URLs, with no fragment, of the Web Workers
  // the test's pages started (Playwright's worker event), for busyWorkers.
  private readonly workerUrls = new Set<string>();
  // While busyWorkers watches: its check, run again as each call ends.
  private busy: (() => void) | null = null;

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
      onRoute(p, (r, threw) => this.routed(r, threw));
      if (this.stops) p.on('worker', (w) => this.workerUrls.add(noFragment(w.url())));
    };
    // Nor for a request a route answers itself with a redirect (Chromium,
    // for a Web Worker's script: its worker never starts, with no keploy
    // too; Firefox, for the redirect's first request), nor for one a route
    // holds after its handler threw (WebKit refuses a redirect, and
    // Playwright's fulfill throws): routed watches each route a page's
    // routes, and then its context's, are handed.
    onRoute(context, (r, threw) => this.routed(r, threw));
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
   * Chromium (stops) reports a Web Worker's script load finished only once
   * the worker's top-level code returns, so settle waits as long as that
   * code runs. Once ms have passed from this call, and again as each call
   * ends after, when every call still in flight is the script load of a Web
   * Worker (a script request at the URL, fragment aside, of a Web Worker one
   * of the test's pages started), say gets each such URL, once for each.
   * Returns the function that stops it. Other engines report the load's end
   * as the script arrives, and nothing is said there.
   */
  busyWorkers(ms: number, say: (url: string) => void): () => void {
    const told = new Set<string>();
    const check = (): void => {
      for (const u of this.workerLoads()) {
        if (told.has(u)) continue;
        told.add(u);
        say(u);
      }
    };
    const t = setTimeout(() => {
      this.busy = check;
      check();
    }, ms);
    return () => {
      clearTimeout(t);
      this.busy = null;
    };
  }

  // The URLs (no fragment) of the calls in flight when every one is a Web
  // Worker's script load (busyWorkers); none otherwise.
  private workerLoads(): string[] {
    const urls = new Set<string>();
    for (const r of this.open.keys()) {
      const u = noFragment(r.url());
      if (r.resourceType() !== 'script' || !this.workerUrls.has(u)) return [];
      urls.add(u);
    }
    return [...urls];
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

  /**
   * Watches route, a request's route. Once its fulfill returns, the
   * request has the whole answer the route gave, and nothing of it is in
   * flight, whatever the browser reports after. threw: the routes' handler
   * threw (called again, after the first call); a request its route still
   * holds then (no route answered it or sent it on: the browser refused
   * its answer, as WebKit refuses a redirect, or the handler threw first)
   * goes nowhere, as Playwright sends it on no further. A handler that
   * returns and leaves the request held keeps it in flight, as one that
   * still might send it on: the test's timeout ends that wait, naming it.
   */
  private routed(route: Route, threw: boolean): void {
    const r = route.request();
    if (threw) {
      // Playwright's own, past its API: set while the handler may still
      // answer the request, cleared once a route answered it or sent it on.
      if ((route as unknown as { _handlingPromise?: unknown })._handlingPromise) this.answered(r);
      return;
    }
    // Bound, not called through Function.prototype.call: Playwright names
    // an API call by how its caller invoked it, and its error must read as
    // Playwright's own (route.fulfill: ...), as with no keploy.
    const fulfill = route.fulfill.bind(route);
    route.fulfill = async (o) => {
      await fulfill(o);
      this.answered(r);
    };
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
    if (this.open.size !== 0) {
      this.busy?.();
      return;
    }
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
}

// Each page's and context's route watcher: the newest Inflight's (a context
// Playwright reuses between tests has one test's at a time).
const routeWatch = new WeakMap<object, (route: Route, threw: boolean) => void>();

/**
 * Has watch see each route Playwright hands target (a page, or a context)
 * before any of target's routes does, and again (threw) when one of their
 * handlers threw: target's _onRoute, Playwright's own, past its API. Where
 * a version has none, no route is watched, and settle waits on such a
 * request as it waits on any other.
 */
function onRoute(target: object, watch: (route: Route, threw: boolean) => void): void {
  const t = target as { _onRoute?: (route: Route) => Promise<void> };
  const on = t._onRoute;
  if (typeof on !== 'function') return;
  const was = routeWatch.has(target);
  routeWatch.set(target, watch);
  if (was) return;
  t._onRoute = async function (this: unknown, route: Route): Promise<void> {
    routeWatch.get(target)?.(route, false);
    try {
      await on.call(this, route);
    } catch (e) {
      routeWatch.get(target)?.(route, true);
      throw e;
    }
  };
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
 * The line a test shows, once for each Web Worker script URL (at), when its
 * end has waited busyWorkers' time with only Web Workers' script loads in
 * flight (Chromium).
 */
export function busyWorkerLine(name: string, at: string): string {
  return `keploy: in ${name}, the test's end waits for the script of the Web Worker at ${at}: Chromium reports a Web Worker's script loaded only once its top-level code returns, ` +
    'so keploy waits until that code returns (or the test times out, naming the load); ' +
    "move the worker's long-running top-level work into its onmessage handler, or end the worker (terminate()) before the test ends.";
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
