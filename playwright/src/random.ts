// Seeded randomness for the test browser. A page that draws random numbers
// (stripe.js picks one of two builds from crypto.randomUUID() at each page
// load) makes other calls each run, and no recording can answer a call it
// never saw. So under keploy each test's browser draws from a seeded stream
// instead. Each test's begin sends a seed drawn afresh, and keploy answers
// the seed to draw from: a record keeps the begin's with the test's
// recording, and a replay answers the recording's. So record and replay
// draw the same numbers and pick the same side, two tests draw different
// ones, and a record made again draws new ones (a browser-made ID is not sent
// twice to a real server). Each page of a test draws its own numbers, so two
// tabs do not make one ID. Only the test browser's pages change; the app,
// its server and the browser's workers do not.
//
// On by default; KEPLOY_SEED_RANDOM=off or the fixture option
// keploySeedRandom: false turns it off.

import type { BrowserContext, Page } from '@playwright/test';
import crypto from 'node:crypto';

export const ENV_SEED_RANDOM = 'KEPLOY_SEED_RANDOM';

/** The option that turns seeding off for a project, a file or a test. */
export const OPTION_SEED_RANDOM = 'keploySeedRandom';

export type Seeding = { mode: 'seeded' } | { mode: 'off' } | { mode: 'refused'; refusal: string };

/** Whether the environment leaves seeding on (unset, on) or turns it off. */
export function seedingFromEnv(env: NodeJS.ProcessEnv): Seeding {
  const v = (env[ENV_SEED_RANDOM] ?? '').trim();
  const l = v.toLowerCase();
  if (l === '' || l === 'on' || l === '1' || l === 'true') return { mode: 'seeded' };
  if (l === 'off' || l === '0' || l === 'false') return { mode: 'off' };
  return {
    mode: 'refused',
    refusal: `keploy: ${ENV_SEED_RANDOM}=${JSON.stringify(v)} is neither on nor off; set it to off to give the test browser its own random numbers, ` +
      'or unset it to seed them per test',
  };
}

/** The line a worker shows once, at the first test whose browser it seeds. */
export const SEEDED_LINE = 'keploy: the test browser\'s random numbers (Math.random, crypto.getRandomValues, crypto.randomUUID) are seeded per test ' +
  'from a seed keploy keeps with the test\'s recording, so a replay draws the numbers its recording drew; ' +
  'Web Workers and Service Workers keep the browser\'s own, and so does a page the app opens that keploy cannot place (each one is named). ' +
  `To turn it off, record and replay with ${ENV_SEED_RANDOM}=off, or set use: { ${OPTION_SEED_RANDOM}: false } in the Playwright config.`;

/**
 * The line a test shows when it asked keploy for a seed and got none, so its
 * pages draw the browser's own random numbers.
 */
export function unseededLine(name: string): string {
  return `keploy: keploy answered the begin of ${name} with no seed, so its browser draws its own random numbers: ` +
    'its recording kept none (it was recorded before keploy kept seeds, or with seeding off: record the test again with seeding on, the default, to seed it), ' +
    'or the test was pulled from a Keploy branch, which keeps no seed, or this keploy predates seeds.';
}

/**
 * An address a page sent, as the run's output shows it: one line (each
 * control character a ?), of at most 512 characters.
 */
export function pageAddress(at: unknown): string {
  return String(at).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 512);
}

/**
 * Why the seeding could not place a document: 'own' for one in a page the
 * test opened that drew before keploy named the page, 'frame' for a frame
 * it cannot place among its parent's frames (initScript), 'popup' for one
 * in a page the app opened, 'uncounted' for a frame under a parent of
 * another origin that has no session storage to count its documents in, or
 * a frame inside one, 'nostorage' for a top document with no session
 * storage to count its documents in (other than a page's first document),
 * or a frame of its origin inside one.
 */
export type Unplaced = 'own' | 'frame' | 'popup' | 'uncounted' | 'nostorage';

const UNPLACED: Record<Exclude<Unplaced, 'uncounted'>, string> = {
  own: 'it is in a page the test opened, and it drew before keploy named that page: a script the test added with context.addInitScript ' +
    'runs in each of the page\'s documents before keploy\'s, and so does a draw the test makes there before newPage returns.',
  frame: 'it is a frame keploy cannot place among its parent\'s frames (one in a closed shadow root or in an object or embed element, ' +
    'which its parent document cannot list, or one whose document began after its removal), or a frame inside one.',
  popup: 'it is in a page the app opened that keploy cannot place in the test\'s order (a popup opened with noopener, as a link with target=_blank opens one, ' +
    'or at another origin than its opener\'s page, or after that page moved on, or by a document keploy could not place; or a frame of another origin in one).',
  nostorage: 'it is a top document with no session storage that keploy can keep its count in (a document of an opaque origin has none: an about:blank loaded after ' +
    'its page\'s first document, a data: URL, a page served with a CSP sandbox without allow-same-origin, or a popup that a page\'s first document opened; ' +
    'or the app has filled it), or a frame of its origin inside one: keploy cannot count the documents loaded at its path in the tab, so seeded, ' +
    'the next one there (a reload, or another visit to that path) could draw the same numbers.',
};

/**
 * The line a test shows, once for each address and reason, when a document
 * of its seeded context drew the browser's own random numbers because the
 * seeding could not place it among the test's pages (initScript); others: for
 * 'uncounted', how many other frames are beside the frame with no session
 * storage (under its parent): the document's own frame, or the one it is in.
 */
export function unplacedLine(name: string, at: string, why: Unplaced = 'popup', others = 0): string {
  const n = Math.floor(Number(others));
  const reason = why === 'uncounted'
    ? 'it is a frame under a parent of another origin with no session storage (a sandboxed frame without allow-same-origin), or a frame inside one: ' +
      'keploy cannot count the documents that frame loads, so seeded, the next document there (a reload, or a frame the app puts in again at its place)' +
      (n > 0 ? ` or, at its path, one of the ${n} other frame(s) beside that frame` : '') + ' could draw the same numbers.'
    : UNPLACED[why];
  return `keploy: in ${name}, the document at ${at} drew the browser's own random numbers, so its draws may differ at replay: ${reason}`;
}

/** A seed drawn afresh for a test's begin: 128 bits, as hex. */
export function freshSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}

// A key of the page's session storage: how many documents of each path the
// tab has loaded from the document's origin, so that a document loaded again
// in the same tab (a reload, a second visit) draws new numbers, as it would
// unseeded, and still the same ones each run.
export const LOADS_KEY = '__keploy_random_loads';

// The window property, not enumerable, that names the page a document is
// in: set by pageScript in every document of a page the test opened.
export const PAGE_KEY = '__keploy_random_page';

// The window property, not enumerable, that holds a document's place for the
// windows it opens and the frames it holds.
export const DOC_KEY = '__keploy_random_doc';

/**
 * The init script that names the page a test opened (context.newPage(), the
 * page fixture's among them) in each of its documents and frames: its place
 * among the pages the test opened in its context, in the order the test
 * opened them. Before newPage returns, the fixture adds it to the page, for
 * each document the page loads, and runs it in the page's first document
 * (its about:blank, which setContent writes into): initScript reads the
 * name at the document's first draw.
 */
export function pageScript(id: string): string {
  return `Object.defineProperty(globalThis, ${JSON.stringify(PAGE_KEY)}, { value: ${JSON.stringify(id)}, enumerable: false, writable: false, configurable: true });\n`;
}

/**
 * pageScript for the page's first document (its about:blank, which
 * setContent writes into), run in it as newPage returns: it also tells the
 * seeding in that document (initScript) that the document is the page's
 * first, with mark, the value the context's init script was given, which
 * the page's own scripts do not know. No engine gives that document session
 * storage, and it is the one document of its kind in its tab, so it is
 * seeded with no count; any other top document with no session storage is
 * not.
 */
export function firstScript(id: string, mark: string): string {
  return `${pageScript(id)}try { globalThis[${JSON.stringify(DOC_KEY)}].first(${JSON.stringify(mark)}); } catch (e) {}\n`;
}

/**
 * Names each page the test opens in context (context.newPage(), the page
 * fixture's among them) by its place in the order the test opened them, in
 * every document of the page, its first about:blank included, before
 * newPage returns: two tabs of a test draw their own numbers, the same ones
 * at replay. A popup is placed by its opener's document in the page itself
 * (initScript). mark: the value the context's init script was given, by
 * which it knows a page's first document (firstScript). Returns what undoes
 * it, and whether a page is one the test opened, once every newPage the
 * test has asked for has come.
 */
export function placePages(context: BrowserContext, mark: string): { restore: () => void; opened: (page: Page | null | undefined) => Promise<boolean> } {
  const had = Object.prototype.hasOwnProperty.call(context, 'newPage');
  const newPage = context.newPage;
  let made = 0;
  // The test's pages, and those it has asked for that have not come yet.
  const pages = new WeakSet<Page>();
  const coming = new Set<Promise<Page>>();
  context.newPage = async function placed(this: BrowserContext): Promise<Page> {
    // Its place is taken when the test asks for it, not when the page
    // comes: two pages asked for at once keep the order the test asked in.
    const id = `t${made++}`;
    const asked = newPage.call(context);
    coming.add(asked);
    let p: Page;
    try {
      p = await asked;
    } finally {
      coming.delete(asked);
    }
    pages.add(p);
    // The documents the page loads, and the one it has: an init script
    // does not run in a document that already exists.
    await p.addInitScript({ content: pageScript(id) });
    await p.evaluate(firstScript(id, mark));
    return p;
  };
  return {
    restore: () => {
      if (had) context.newPage = newPage;
      else delete (context as { newPage?: unknown }).newPage;
    },
    // A page's first document may tell before its newPage has come.
    opened: async (page) => {
      const came = await Promise.allSettled([...coming]);
      return pages.has(page as Page) || came.some((c) => c.status === 'fulfilled' && c.value === page);
    },
  };
}

/**
 * The init script that seeds a document: one stream for each of
 * Math.random, crypto.getRandomValues and crypto.randomUUID, from the seed,
 * the document's page, its path, and how many documents of that path
 * loaded before it in its frame (for a top document, or a frame under a
 * parent of another origin: its origin in the tab).
 *
 * The page keeps two tabs of a test from drawing the same numbers (a
 * browser-made tab ID or idempotency key reaches a real server in a record),
 * and is the same at replay:
 *   - a page the test opened is named by pageScript: its place in the order
 *     the test opened its pages. A top document with no session storage to
 *     count its documents in (an opaque origin) is never seeded, but for
 *     the page's first document, which firstScript marks: it draws the
 *     browser's own numbers and is named, since seeded, the next document
 *     at its path in the tab (a reload, another visit) could draw its
 *     numbers;
 *   - a popup is the window its opener's document opened with window.open,
 *     in the order that document opened them, read when the popup's
 *     document begins (or, for a document that took over its window's
 *     first about:blank and so ran no init script, at its first draw); it
 *     needs an opener of its own origin;
 *   - a frame of its parent's origin is in its parent document, at the
 *     path its element asks for and its number among the parent's frames
 *     that were put in at that path, by element, in the order the parent
 *     document holds them when it numbers them (as the task that put them
 *     in ends, or as a frame's document begins): frames at other paths, and
 *     the order the frames' documents load in, do not move it, and it keeps its place whatever it loads. An
 *     about:blank frame does not draw its parent document's numbers;
 *   - a frame under a parent of another origin, which it cannot read, is
 *     in the page the test opened, by its path and how many documents of
 *     that path its origin loaded in the tab before. One with no session
 *     storage to count them in (a sandboxed frame) is never seeded: it
 *     draws the browser's own numbers and is named, since seeded, its next
 *     document (a reload, or a frame put in again at its place) or a frame
 *     beside it could draw its numbers.
 * A document with no place (a popup opened with noopener, as a link with
 * target=_blank opens one, or of another origin than its opener's page, or
 * after its opener's page moved on; a frame of another origin in one; a
 * frame its parent cannot list: one in a closed shadow root, or in an
 * object or embed; a frame whose document began after its removal) draws
 * the browser's own numbers, never another page's, and says so through
 * report, the name of a function the fixture exposed ('' for none), at its
 * first draw, with its address, why ('frame' for a frame its parent
 * cannot place, 'uncounted' for a frame under a parent of another origin
 * with no session storage, or one in such a frame, 'nostorage' for a top
 * document with no session storage, or a frame of its origin in one, else
 * '') and, for 'uncounted', how many other frames are beside that frame.
 *
 * The path alone names the document in its frame: a replay may serve the
 * app at another host or port than its record did, and a query often
 * carries a time. A stream for each function keeps one's draws from
 * shifting another's: a timer's Math.random does not move the next
 * crypto.randomUUID.
 *
 * mark: the value by which firstScript marks a page's first document ('' for
 * none, so no document is marked).
 */
export function initScript(seed: string, report = '', mark = ''): string {
  return `(() => {
  const seed = ${JSON.stringify(seed)};
  const mark = ${JSON.stringify(mark)};
  const g = globalThis;
  const imul = Math.imul;
  // cyrb128: a string's 128-bit hash, a stream's four words.
  const hash = (s) => {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < s.length; i++) {
      const k = s.charCodeAt(i);
      h1 = h2 ^ imul(h1 ^ k, 597399067);
      h2 = h3 ^ imul(h2 ^ k, 2869860233);
      h3 = h4 ^ imul(h3 ^ k, 951274213);
      h4 = h1 ^ imul(h4 ^ k, 2716044179);
    }
    h1 = imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  };
  // sfc32 over those words: 32 random bits a call.
  const stream = (s) => {
    let [a, b, c, d] = hash(s);
    const next = () => {
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return t >>> 0;
    };
    for (let i = 0; i < 15; i++) next();
    return next;
  };
  // The fixture's function that hears of a document with no place, taken
  // off the window so the page does not see it.
  let tell = null;
  ${report === '' ? '' : `try { const f = g[${JSON.stringify(report)}]; if (typeof f === 'function') tell = f; delete g[${JSON.stringify(report)}]; } catch (e) { tell = null; }`}
  // Taken as the script begins: the page's own scripts run after it.
  const WM = WeakMap;
  const Mp = Map;
  const U = g.URL;
  const MO = g.MutationObserver;
  // A frame's element, read through the window's own getter, taken now: the
  // parent finds the frame by it, and never reads another frame's window.
  let elementGetter = null;
  try {
    const d = Object.getOwnPropertyDescriptor(g, 'frameElement');
    if (d && typeof d.get === 'function') elementGetter = d.get;
  } catch (e) { elementGetter = null; }
  const frameElementOf = () => { try { return elementGetter !== null ? elementGetter.call(g) : g.frameElement; } catch (e) { return null; } };
  // The name pageScript gives the page the test opened, in each of its
  // documents and frames (it runs after this script); null for none.
  const named = () => { try { const v = g[${JSON.stringify(PAGE_KEY)}]; return typeof v === 'string' ? v : null; } catch (e) { return null; } };
  // The path a frame element asks its frame to load: the src's path (its
  // host, port and query are not, as a document's are not), about:srcdoc,
  // or about:blank for none.
  // A src of another scheme names its scheme only (a blob: URL carries a
  // browser-made ID); one keploy cannot read is ?.
  const srcOf = (el, doc) => {
    try {
      if (el.hasAttribute('srcdoc')) return 'about:srcdoc';
      const a = el.getAttribute('src');
      if (a === null || a === '') return 'about:blank';
      const u = new U(a, doc.baseURI);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.pathname : u.protocol;
    } catch (e) {
      return '?';
    }
  };
  // The place a frame element takes at the path it asks for: how many
  // frames of this document were put in at that path before it.
  const next = (s, el) => {
    const at = srcOf(el, s.doc);
    const n = s.numbers.get(at) || 0;
    s.numbers.set(at, n + 1);
    return 'f' + at + '\\n' + n;
  };
  const isFrame = (n) => { const t = n.localName; return t === 'iframe' || t === 'frame'; };
  // Numbers the frame elements of the document that have none yet, in the
  // order of the elements in the document (an open shadow root's at its
  // host). It reads elements alone, never a frame's window: reading one
  // makes Chromium begin that frame's first document, whose init script
  // would ask this document again, a frame deeper each time.
  const number = (s) => {
    const visit = (root) => {
      let all = null;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (isFrame(el) && !s.els.has(el)) { s.els.set(el, next(s, el)); s.held++; }
        let r = null;
        try { r = el.shadowRoot; } catch (e) { r = null; }
        if (r) visit(r);
      }
    };
    visit(s.doc);
  };
  // Whether a node the app put in or took out is a frame element, or holds
  // one outside its shadow roots. A node with no element child (a text
  // node, a leaf element) holds none, and costs no query.
  const holds = (n) => {
    try { return isFrame(n) || (n.firstElementChild != null && n.querySelector('iframe,frame') !== null); } catch (e) { return false; }
  };
  // A frame element taken out loses its number: put back, it holds another
  // window, and takes the next number at its path.
  const drop = (s, el) => { if (s.els.delete(el)) s.held--; s.bound.delete(el); };
  const forget = (s, n) => {
    try {
      if (isFrame(n)) drop(s, n);
      const all = n.querySelectorAll('iframe,frame');
      for (let i = 0; i < all.length; i++) drop(s, all[i]);
    } catch (e) {
      // A node with no elements.
    }
  };
  // What the app's changes to the document's nodes, in order, do to its
  // frames: one taken out is forgotten (looked for only while the document
  // holds a numbered frame), and the document numbers its frames only when
  // one was put in (a change that puts in no frame costs no walk).
  const take = (s, records) => {
    let put = false;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (s.held > 0) {
        const out = r.removedNodes;
        for (let j = 0; j < out.length; j++) if (holds(out[j])) forget(s, out[j]);
      }
      if (!put) {
        const added = r.addedNodes;
        for (let j = 0; j < added.length; j++) if (holds(added[j])) { put = true; break; }
      }
    }
    if (put) number(s);
  };
  // Numbers a document's frames as the app puts them in (at the end of the
  // task that put them, or as a frame's document begins, whichever comes
  // first), so that the order their documents load in (the network's) does
  // not decide their numbers. The observer watches the document's childList
  // outside its shadow roots: a frame put into a shadow root already in the
  // page is numbered when the app next puts a frame in outside them, or when
  // a document of one of the parent's frames, its own included, begins.
  const watch = (s) => {
    try {
      const mo = new MO((records) => { take(s, records); });
      mo.observe(s.doc, { childList: true, subtree: true });
      s.mo = mo;
    } catch (e) {
      // No document or no observer: frames are numbered as their documents
      // begin.
    }
  };
  // A document's state: its path; how many documents of that path loaded
  // before it in its frame, or for a top document or a frame under a parent
  // of another origin in its origin in the tab; what it is (a top document,
  // a frame of its parent's origin, or one under a parent of another
  // origin); a frame's parent and its place among the parent's frames; the
  // place its opener gives a top document; the windows it opened; its own
  // frames' places and loads; and its streams. Made as the document begins;
  // made again at the next draw when the window has a new document that ran
  // no init script: a popup's first document of its opener's origin takes
  // over the window of its first about:blank.
  const begin = (doc) => {
    let place = '';
    try { place = location.pathname; } catch (e) { place = ''; }
    // A frame's parent document, when keploy can read it (of the frame's
    // origin): it places the frame and counts its loads. A frame under a
    // parent of another origin cannot read it.
    let kind = 'top';
    let up = null;
    let frame = null;
    let loads = 0;
    // The parent as the document begins, before any script of the page has
    // run: a page script may replace the global parent (var parent = ...).
    let par = null;
    try {
      const p = g.parent;
      par = p;
      if (p !== g) {
        kind = 'frame';
        if (p !== null && p !== undefined) {
          let d = null;
          try { d = p[${JSON.stringify(DOC_KEY)}]; } catch (e) { kind = 'other'; }
          if (d) {
            const e = d.enter(frameElementOf(), g, place);
            up = d;
            frame = e[0];
            loads = e[1];
          }
        }
      }
    } catch (e) {
      // A parent keploy cannot ask: no place.
      kind = 'frame';
    }
    // Whether session storage counted this document's loads.
    let counted = false;
    if (kind !== 'frame') {
      try {
        const store = sessionStorage;
        let seen = {};
        try { seen = JSON.parse(store.getItem(${JSON.stringify(LOADS_KEY)}) || '{}') || {}; } catch (e) { seen = {}; }
        if (typeof seen !== 'object' || Array.isArray(seen)) seen = {};
        loads = typeof seen[place] === 'number' ? seen[place] : 0;
        seen[place] = loads + 1;
        store.setItem(${JSON.stringify(LOADS_KEY)}, JSON.stringify(seen));
        counted = true;
      } catch (e) {
        // No session storage here (a sandboxed frame, an opaque origin): every
        // document of this path in the tab would draw the same numbers, so
        // neither a frame under a parent of another origin nor a top
        // document (but a page's first) is seeded (pageOf).
      }
    }
    // A top document's opener, read as the document begins: an opener may
    // move on later (a frame's is read too, and not used).
    let given = null;
    try {
      const o = g.opener;
      if (o) {
        const d = o[${JSON.stringify(DOC_KEY)}];
        const i = d ? d.opened().indexOf(g) : -1;
        const k = i >= 0 ? d.key() : null;
        if (k !== null) given = k + 'w' + i;
      }
    } catch (e) {
      // An opener of another origin.
      given = null;
    }
    const s = { doc, place, loads, counted, par, kind, up, frame, given, page: undefined, first: false, uncounted: false, others: 0, opened: [], els: new WM(), held: 0, bound: new WM(), mo: null, numbers: new Mp(), counts: new Mp(), streams: null };
    watch(s);
    return s;
  };
  const docNow = () => { try { return document; } catch (e) { return null; } };
  let state = begin(docNow());
  const now = () => {
    const doc = docNow();
    if (state.doc !== doc) state = begin(doc);
    return state;
  };
  // The place frame element el of this document takes, for its window w,
  // and how many documents at path w loaded before in that place: [place,
  // loads]; [null, 0] when el is not among this document's frames (one in a
  // closed shadow root, in an object or embed element, or taken out). The
  // app's changes not yet seen are taken first, in order. An element whose
  // number another window holds was put back where the observer does not
  // see (in a shadow root): it takes the next number at its path.
  const enter = (el, w, path) => {
    const s = now();
    if (s.mo !== null) take(s, s.mo.takeRecords());
    if (!s.els.has(el)) number(s);
    if (!s.els.has(el)) return [null, 0];
    const had = s.bound.get(el);
    if (had !== undefined && had !== w) s.els.set(el, next(s, el));
    s.bound.set(el, w);
    const f = s.els.get(el);
    const c = f + '\\n' + path;
    const n = s.counts.get(c) || 0;
    s.counts.set(c, n + 1);
    return [f, n];
  };
  // The document's page, when first asked: for a top document, the page
  // the test opened (the page script runs after this one, before the
  // page's own scripts), or the place its opener gives it; for a frame of
  // its parent's origin, its parent document's key and its place among
  // that document's frames; for a frame under a parent of another origin,
  // the page the test opened, marked as such a frame. null for none, and
  // for a frame under a parent of another origin whose loads session
  // storage did not count: nothing tells its documents at one path apart
  // (a reload, a frame put in again at its place, another frame beside it),
  // and seeded they would draw the same numbers (a browser-made ID sent
  // twice to a real server in a record). Its line says how many other
  // frames its parent holds: the parent's frame count, readable across
  // origins, read from the parent as the document began (its own scripts
  // may have replaced the global parent since); 1 when it cannot be read.
  const othersOf = (s) => { try { const n = Number(s.par.length); return Number.isFinite(n) ? n - 1 : 1; } catch (e) { return 1; } };
  const pageOf = () => {
    const s = now();
    if (s.page === undefined) {
      let p = null;
      if (s.kind === 'top') {
        p = named();
        if (p === null) p = s.given;
        // A top document whose loads session storage did not count (an
        // opaque origin) is not seeded: nothing tells it apart from the next
        // document at its path in the tab (a reload, another visit, a popup
        // opened again), and seeded they would draw the same numbers. A
        // page's first document is the one of its kind in its tab.
        if (p !== null && !s.counted && !s.first) { s.uncounted = true; p = null; }
      } else if (s.kind === 'other') {
        const t = named();
        if (t !== null && !s.counted) { s.uncounted = true; s.others = othersOf(s); }
        p = t === null || s.uncounted ? null : t + 'x';
      } else if (s.frame !== null) {
        const k = s.up.key();
        p = k === null ? null : k + s.frame;
      }
      s.page = p;
    }
    return s.page;
  };
  // Why a document with no page has none: 'frame' for a frame its parent
  // cannot place, 'uncounted' for a frame under a parent of another origin
  // with no session storage, or one in such a frame, 'nostorage' for a top
  // document with no session storage, or a frame of its origin in one, else
  // ''. othersFor: how many other frames are beside that frame, under its
  // parent.
  const whyOf = () => {
    const s = now();
    if (s.kind === 'top') return s.uncounted ? 'nostorage' : '';
    if (s.kind === 'other') return s.uncounted ? 'uncounted' : '';
    if (s.kind !== 'frame') return '';
    return s.frame === null ? 'frame' : s.up.why();
  };
  const othersFor = () => {
    const s = now();
    if (s.kind === 'other') return s.others;
    return s.kind === 'frame' && s.frame !== null ? s.up.others() : 0;
  };
  const key = () => { const p = pageOf(); const s = now(); return p === null ? null : seed + '\\n' + p + '\\n' + s.place + '\\n' + s.loads + '\\n'; };
  let mine;
  try {
    // first: firstScript, in a page's first document, marks it as such
    // (its state, so a later document that takes over the window is not),
    // with the mark the fixture gave this script, which a page's own script
    // does not know.
    const d = Object.freeze({ key, why: whyOf, others: othersFor, enter, opened: () => now().opened, first: (m) => { if (mark !== '' && m === mark) now().first = true; } });
    Object.defineProperty(g, ${JSON.stringify(DOC_KEY)}, { value: d, enumerable: false, writable: false, configurable: true });
    mine = d;
  } catch (e) {
    // A window that takes no property: nothing it opens or holds has a place.
  }
  // Whether a later run of this script in the window has taken over: WebKit
  // runs it again in a document that takes over its window's first
  // about:blank, over this run's functions. This run then only passes on
  // the browser's own, so the document begins once.
  const stale = () => { try { return g[${JSON.stringify(DOC_KEY)}] !== mine; } catch (e) { return false; } };
  // The document's stream for name, made at its first draw; null when it
  // has no place, so it draws the browser's own numbers, and says so once.
  const from = (name) => {
    if (stale()) return null;
    const s = now();
    if (s.streams === null) {
      const k = key();
      s.streams = k === null ? false : {
        random: stream(k + 'Math.random'),
        grv: stream(k + 'crypto.getRandomValues'),
        uuid: stream(k + 'crypto.randomUUID'),
      };
      if (s.streams === false && tell !== null) {
        // Its address: origin and path, or for an opaque origin (about:blank,
        // about:srcdoc, a data: URL, a sandboxed frame or page) its URL, with
        // no query or fragment. A window's first document has no URL yet
        // while Firefox runs its init scripts: it is about:blank. Why: whyOf.
        let at = '';
        try {
          const o = location.origin;
          at = o && o !== 'null' ? o + location.pathname : String(location.href).split(/[?#]/)[0];
        } catch (e) { at = ''; }
        if (at === '') at = 'about:blank';
        const why = whyOf();
        try { const r = tell(at, why, othersFor()); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {}
      }
    }
    return s.streams === false ? null : s.streams[name];
  };
  const define = (o, name, value) => {
    const d = Object.getOwnPropertyDescriptor(o, name);
    Object.defineProperty(o, name, { value, writable: d ? d.writable : true, enumerable: d ? d.enumerable : false, configurable: true });
  };
  const fill = (next, u) => {
    for (let i = 0; i < u.length; i += 4) {
      let w = next();
      for (let j = 0; j < 4 && i + j < u.length; j++) { u[i + j] = w & 255; w >>>= 8; }
    }
  };
  const realOpen = g.open;
  if (typeof realOpen === 'function') {
    define(g, 'open', { open() {
      const w = realOpen.apply(this, arguments);
      try { if (!stale()) { const opened = now().opened; if (w && opened.indexOf(w) < 0) opened.push(w); } } catch (e) {}
      return w;
    } }.open);
  }
  const realRandom = Math.random;
  // 53 bits, as the browser's own Math.random gives.
  define(Math, 'random', { random() {
    const rnd = from('random');
    if (rnd === null) return realRandom();
    return ((rnd() >>> 5) * 67108864 + (rnd() >>> 6)) / 9007199254740992;
  } }.random);
  const C = typeof Crypto === 'function' ? Crypto.prototype : null;
  if (C && typeof C.getRandomValues === 'function') {
    const real = C.getRandomValues;
    define(C, 'getRandomValues', { getRandomValues(array) {
      // The browser's own call first: it refuses what the browser refuses
      // (a float array, more than 65536 bytes, a this that is no Crypto).
      const out = real.call(this, array);
      const grv = from('grv');
      if (grv !== null) fill(grv, new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
      return out;
    } }.getRandomValues);
  }
  if (C && typeof C.randomUUID === 'function') {
    const realUUID = C.randomUUID;
    define(C, 'randomUUID', { randomUUID() {
      const own = realUUID.call(this);
      const uuid = from('uuid');
      if (uuid === null) return own;
      const b = new Uint8Array(16);
      fill(uuid, b);
      b[6] = (b[6] & 15) | 64;
      b[8] = (b[8] & 63) | 128;
      let h = '';
      for (let i = 0; i < 16; i++) {
        h += (b[i] + 256).toString(16).slice(1);
        if (i === 3 || i === 5 || i === 7 || i === 9) h += '-';
      }
      return h;
    } }.randomUUID);
  }
})();
`;
}
