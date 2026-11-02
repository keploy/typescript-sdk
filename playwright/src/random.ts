// Seeded randomness for the test browser and the test process. A page that
// draws random numbers (stripe.js picks one of two builds from
// crypto.randomUUID() at each page load) makes other calls each run, and no
// recording can answer a call it never saw. A suite that makes its test data
// in the test process (a lead named with Math.random()) sends other data each
// run, and a mocked dependency answers with the recording's. So under keploy
// each test's browser and its test process draw from seeded streams instead.
// Each test's begin sends a seed drawn afresh, and keploy answers the seed to
// draw from: a record keeps the begin's with the test's recording, and a
// replay answers the recording's. So record and replay draw the same numbers,
// pick the same side and make the same data, two tests draw different ones,
// and a record made again draws new ones (a browser-made ID is not sent twice
// to a real server). Each page of a test draws its own numbers, so two tabs
// do not make one ID. Only the test browser's pages and the test process's
// Math.random change; the app, its server and the browser's workers do not.
//
// On by default; KEPLOY_SEED_RANDOM=off or the fixture option
// keploySeedRandom: false turns it off, and the worker says what that costs.

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
    refusal: `keploy: ${ENV_SEED_RANDOM}=${JSON.stringify(v)} is neither on nor off; set it to off to give the test browser and the test process their own random numbers, ` +
      'or unset it to seed them per test',
  };
}

/** The line a worker shows once, at the first test it seeds. */
export const SEEDED_LINE = 'keploy: each test\'s random numbers are seeded from a seed keploy keeps with the test\'s recording, so a replay draws the numbers its recording drew: ' +
  'in the test browser Math.random, crypto.getRandomValues and crypto.randomUUID, and in the test process Math.random, from the test\'s begin to its end ' +
  '(its beforeEach and afterEach hooks too). ' +
  'Web Workers and Service Workers keep the browser\'s own, and so does a page the app opens that keploy cannot place (each one is named); ' +
  'the test process keeps its own crypto, and its own Math.random outside every test (beforeAll, afterAll, a worker fixture, a file as it loads). ' +
  `To turn it off, record and replay with ${ENV_SEED_RANDOM}=off, or set use: { ${OPTION_SEED_RANDOM}: false } in the Playwright config.`;

/**
 * The line a worker shows once, at the first test it runs with seeding off:
 * what the test's own random numbers cost a replay.
 */
export const OFF_LINE = `keploy: random numbers are not seeded (${ENV_SEED_RANDOM}=off, or ${OPTION_SEED_RANDOM}: false), ` +
  'so the test process and the test browser draw their own each run: data a test makes from them (a name, an email, an ID) differs from its recording\'s ' +
  'while a mocked dependency answers with the recording\'s, so a test that checks one against the other fails or is set aside, ' +
  'and a page script\'s random choice may make calls the recording never saw. ' +
  `Unset ${ENV_SEED_RANDOM} and ${OPTION_SEED_RANDOM} to seed them per test.`;

/**
 * The line a test shows when it asked keploy for a seed and got none, so its
 * pages and its test process draw their own random numbers.
 */
export function unseededLine(name: string): string {
  return `keploy: keploy answered the begin of ${name} with no seed, so its browser and its test process draw their own random numbers: ` +
    'its recording kept none (it was recorded before keploy kept seeds, or with seeding off: record the test again with seeding on, the default, to seed it), ' +
    'or the test was pulled from a Keploy branch, which keeps no seed yet, or this keploy predates seeds.';
}

/**
 * The line a test shows, once for each address, when a document of its
 * seeded context drew the browser's own random numbers because the seeding
 * could not place it among the test's pages (initScript).
 */
export function unplacedLine(name: string, at: string): string {
  return `keploy: in ${name}, the document at ${at} drew the browser's own random numbers, so its draws may differ at replay: ` +
    'it is in a page the app opened that keploy cannot place in the test\'s order (a popup opened with noopener, as a link with target=_blank opens one, ' +
    'or at another origin than its opener\'s page, or after that page moved on; or a frame of another origin in one).';
}

/** A seed drawn afresh for a test's begin: 128 bits, as hex. */
export function freshSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * The stream a test's process draws Math.random from under seed: sfc32 over
 * the SHA-256 of the seed and the stream's name, 53 bits a draw, as Node's
 * own Math.random gives. A replay draws what its recording drew only while
 * this stays the same: a recording keeps the seed, not the numbers.
 */
export function processRandom(seed: string): () => number {
  const h = crypto.createHash('sha256').update(`${seed}\ntest process\nMath.random`).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = (): number => {
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
  return () => ((next() >>> 5) * 67108864 + (next() >>> 6)) / 9007199254740992;
}

/**
 * Puts draw in Math.random's place in this process until the returned
 * function puts the process's own back. That one puts it back only while
 * Math.random is still draw: a test that put its own stub there keeps it.
 *
 * A draw made while a stack trace is prepared is not the test's, so it is
 * the process's own. Playwright maps each stack frame through its file's
 * source map (source-map-support's Error.prepareStackTrace, and the one it
 * sets for a moment to read where test.step or test was called), and
 * source-map parses a file's map the first time one of its frames is
 * mapped, sorting it with pivots from Math.random. A worker parses each
 * file once, in the first test whose stack reaches it (a helper file's
 * test.step, an expect, an Error's stack read), so those draws would make
 * a test's numbers depend on which tests its worker ran before it: a replay
 * of one test alone, or one after keploy set an earlier test aside, would
 * draw other numbers than its recording. Every stack trace is prepared
 * through Error.prepareStackTrace, so while seated that property holds the
 * function last set there wrapped, and reading it gives the wrapper (one
 * for each function, so two reads are the same); setting a wrapper sets
 * its function. Putting back gives Error.prepareStackTrace its own
 * property again, holding the function last set: a test that defined the
 * property itself keeps its definition.
 */
export function seatRandom(draw: () => number): () => void {
  const own = Math.random;
  // How many stack traces are being prepared now, one inside another.
  let preparing = 0;
  const seeded = { random(): number { return preparing > 0 ? own() : draw(); } }.random;
  const E = Error as { prepareStackTrace?: unknown };
  const was = Object.getOwnPropertyDescriptor(E, 'prepareStackTrace');
  let set: unknown = E.prepareStackTrace;
  const wrapperOf = new WeakMap<object, unknown>();
  const wrapped = new WeakMap<object, unknown>();
  const get = (): unknown => {
    if (typeof set !== 'function') return set;
    let w = wrapperOf.get(set);
    if (w === undefined) {
      const f = set;
      w = { prepareStackTrace(this: unknown, ...args: unknown[]): unknown {
        preparing++;
        try {
          return Reflect.apply(f, this, args);
        } finally {
          preparing--;
        }
      } }.prepareStackTrace;
      wrapperOf.set(f, w);
      wrapped.set(w as object, f);
    }
    return w;
  };
  const put = (v: unknown): void => { set = typeof v === 'function' && wrapped.has(v) ? wrapped.get(v) : v; };
  Object.defineProperty(E, 'prepareStackTrace', { get, set: put, enumerable: was?.enumerable ?? true, configurable: true });
  Math.random = seeded;
  return () => {
    if (Math.random === seeded) Math.random = own;
    if (Object.getOwnPropertyDescriptor(E, 'prepareStackTrace')?.get !== get) return;
    if (was === undefined) delete E.prepareStackTrace;
    else Object.defineProperty(E, 'prepareStackTrace', was);
    if (E.prepareStackTrace !== set) E.prepareStackTrace = set;
  };
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
 * opened them. The fixture adds it to the page before newPage returns, so it
 * runs in the page's first document.
 */
export function pageScript(id: string): string {
  return `Object.defineProperty(globalThis, ${JSON.stringify(PAGE_KEY)}, { value: ${JSON.stringify(id)}, enumerable: false, writable: false, configurable: true });\n`;
}

/**
 * The init script that seeds a document: one stream for each of
 * Math.random, crypto.getRandomValues and crypto.randomUUID, from the seed,
 * the document's page, its path, and how many documents of that path its
 * origin loaded in the tab before.
 *
 * The page keeps two tabs of a test from drawing the same numbers (a
 * browser-made tab ID or idempotency key reaches a real server in a record),
 * and is the same at replay:
 *   - a page the test opened is named by pageScript: its place in the order
 *     the test opened its pages;
 *   - a popup is the window its opener's document opened with window.open,
 *     in the order that document opened them, read when the popup's
 *     document begins (or, for a document that took over its window's
 *     first about:blank and so ran no init script, at its first draw); it
 *     needs an opener of its own origin;
 *   - a frame of a popup is its parent document's, of the same origin.
 * A document with no place (a popup opened with noopener, as a link with
 * target=_blank opens one, or of another origin than its opener's page, or
 * after its opener's page moved on; a frame of another origin in one) draws
 * the browser's own numbers, never another page's, and says so through
 * report, the name of a function the fixture exposed ('' for none), at its
 * first draw.
 *
 * The path alone names the document in its page: a replay may serve the app
 * at another host or port than its record did, and a query often carries a
 * time. So two frames of different origins at the same path in one page
 * draw the same numbers. A stream for each function keeps one's draws from
 * shifting another's: a timer's Math.random does not move the next
 * crypto.randomUUID.
 */
export function initScript(seed: string, report = ''): string {
  return `(() => {
  const seed = ${JSON.stringify(seed)};
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
  // A document's state: its path, how many documents of that path its
  // origin loaded in the tab before, the place its opener or parent gives
  // it, the windows it opened, and its streams. Made as the document begins;
  // made again at the next draw when the window has a new document that ran
  // no init script: a popup's first document of its opener's origin takes
  // over the window of its first about:blank.
  const begin = (doc) => {
    let place = '';
    try { place = location.pathname; } catch (e) { place = ''; }
    let loads = 0;
    try {
      const store = sessionStorage;
      let seen = {};
      try { seen = JSON.parse(store.getItem(${JSON.stringify(LOADS_KEY)}) || '{}') || {}; } catch (e) { seen = {}; }
      if (typeof seen !== 'object' || Array.isArray(seen)) seen = {};
      loads = typeof seen[place] === 'number' ? seen[place] : 0;
      seen[place] = loads + 1;
      store.setItem(${JSON.stringify(LOADS_KEY)}, JSON.stringify(seen));
    } catch (e) {
      // No session storage here (a sandboxed frame, an opaque origin): every
      // document of this path in the page draws the same numbers.
    }
    // Read as the document begins: an opener or a parent may move on later.
    let given = null;
    try {
      const top = g.top;
      if (top === g || top === undefined || top === null) {
        const o = g.opener;
        if (o) {
          const d = o[${JSON.stringify(DOC_KEY)}];
          const i = d ? d.opened().indexOf(g) : -1;
          const k = i >= 0 ? d.key() : null;
          if (k !== null) given = k + 'w' + i;
        }
      } else {
        const d = g.parent[${JSON.stringify(DOC_KEY)}];
        if (d) given = d.page();
      }
    } catch (e) {
      // An opener or a parent of another origin.
      given = null;
    }
    return { doc, place, loads, given, page: undefined, opened: [], streams: null };
  };
  const docNow = () => { try { return document; } catch (e) { return null; } };
  let state = begin(docNow());
  const now = () => {
    const doc = docNow();
    if (state.doc !== doc) state = begin(doc);
    return state;
  };
  // The document's page, named when first asked: the page script runs
  // after this one, before the page's own scripts.
  const pageOf = () => {
    const s = now();
    if (s.page === undefined) {
      let p = null;
      try { const v = g[${JSON.stringify(PAGE_KEY)}]; if (typeof v === 'string') p = v; } catch (e) { p = null; }
      s.page = p !== null ? p : s.given;
    }
    return s.page;
  };
  const key = () => { const p = pageOf(); const s = now(); return p === null ? null : seed + '\\n' + p + '\\n' + s.place + '\\n' + s.loads + '\\n'; };
  try {
    Object.defineProperty(g, ${JSON.stringify(DOC_KEY)}, { value: Object.freeze({ key, page: pageOf, opened: () => now().opened }), enumerable: false, writable: false, configurable: true });
  } catch (e) {
    // A window that takes no property: nothing it opens or holds has a place.
  }
  // The document's stream for name, made at its first draw; null when it
  // has no place, so it draws the browser's own numbers, and says so once.
  const from = (name) => {
    const s = now();
    if (s.streams === null) {
      const k = key();
      s.streams = k === null ? false : {
        random: stream(k + 'Math.random'),
        grv: stream(k + 'crypto.getRandomValues'),
        uuid: stream(k + 'crypto.randomUUID'),
      };
      if (s.streams === false && tell !== null) {
        let at = '';
        try { at = location.origin + location.pathname; } catch (e) { at = s.place; }
        try { const r = tell(at); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {}
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
      try { const opened = now().opened; if (w && opened.indexOf(w) < 0) opened.push(w); } catch (e) {}
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
