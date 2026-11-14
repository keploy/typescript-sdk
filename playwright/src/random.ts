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

import type { BrowserContext, Frame, Page, Request, Route } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const ENV_SEED_RANDOM = 'KEPLOY_SEED_RANDOM';

/** The option that turns seeding off for a project, a file or a test. */
export const OPTION_SEED_RANDOM = 'keploySeedRandom';

/** The package whose prebuilt instances the test process seeds. */
export const FAKER = '@faker-js/faker';

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
  'in the test browser Math.random, crypto.getRandomValues and crypto.randomUUID, in its pages and the Web Workers and Shared Workers they start, ' +
  'and in the test process Math.random and the instances ' +
  `${FAKER} makes as it loads (faker, fakerDE, ...), from the test's begin to its end ` +
  '(its beforeEach and afterEach hooks too). ' +
  'A Service Worker, a page the app opens and a worker that keploy cannot place or reach keep the browser\'s own (each one is named); ' +
  'the test process keeps its own crypto, and its own Math.random and faker outside every test (beforeAll, afterAll, a file as it loads) ' +
  'and while a worker fixture registered with this package\'s test.extend or test.use is set up. ' +
  'Own Faker instances, those the suite makes itself as a file loads (new Faker(...)), draw their own: seed them with seedFaker(instance, name) ' +
  'from this package. An instance the test seeds itself (faker.seed(n)) draws as seeded. ' +
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
    'or the test was pulled from a Keploy branch, which keeps no seed, or this keploy predates seeds.';
}

/**
 * An address a page sent, as the run's output shows it: one line (each
 * control character a ?), of at most 512 characters.
 */
export function pageAddress(at: unknown): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what it replaces
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
 * or a frame of its origin inside one, 'routed' for a worker whose script
 * a route of the test's own answered itself (workerRoutes), 'continued' for a
 * Shared Worker whose script a route of the test's own sent on with options
 * of its own (workerRoutes), 'nested' for a
 * Web Worker a seeded Web Worker started where the route does not reach its
 * script (NESTED_JS), 'service' for a
 * Service Worker a document registered, 'controlled' for a worker whose
 * script a Service Worker may answer, 'early' for a Shared Worker started
 * before keploy knew whether a Service Worker may answer its script
 * (initScript).
 */
export type Unplaced = 'own' | 'frame' | 'popup' | 'uncounted' | 'nostorage' | 'worker' | 'shared' | 'routed' | 'continued' | 'service' | 'controlled' | 'early' | 'nested';

// The next step for a Service Worker the tests do not need.
const BLOCK = 'if the tests do not need it, set serviceWorkers: \'block\' in the project\'s use (Playwright then registers none, and keploy seeds the workers it would have answered)';

// A worker keploy cannot reach starts its own workers unseeded too: its
// line says so (unplacedLine).
const KIDS = 'and so does each worker it starts, so their draws may differ at replay';

// A worker keploy cannot reach: its line's reason (unplacedLine).
const UNREACHED: Record<'worker' | 'shared' | 'routed' | 'continued' | 'service' | 'early' | 'nested', string> = {
  worker: 'it is a worker started from a script keploy cannot mark (a blob: or data: URL, or a URL the browser refused with keploy\'s mark, as a Trusted Types policy may), ' +
    'so keploy cannot put its seeding ahead of the script; start it from the script\'s http(s) URL to seed it.',
  shared: 'it is a Shared Worker, and Firefox does not let keploy reach a Shared Worker\'s script to put its seeding ahead of it; ' +
    'record and replay the test in Chromium or WebKit to seed it.',
  routed: 'a route of the test\'s own answered the worker\'s script itself (route.fulfill), so keploy cannot put its seeding ahead of the script, ' +
    'and the worker\'s URL, which its location shows, carries keploy\'s __keploy_worker mark; have that route call route.continue() or route.fallback() ' +
    'for the worker\'s script to seed it.',
  continued: 'a route of the test\'s own sent the Shared Worker\'s script on with a URL, method, headers or post data of its own (route.continue or route.fallback with options), ' +
    'and Chromium and WebKit route nothing a Shared Worker loads after its script, as keploy\'s seeding loads the app\'s script, so that load could not carry them; ' +
    'keploy answers the worker with the script that route asked for, unseeded, and the worker\'s URL, which its location shows, carries keploy\'s __keploy_worker mark; ' +
    'have that route continue or fall back with no options for the Shared Worker\'s script to seed it.',
  service: 'keploy cannot put its seeding ahead of a Service Worker\'s script, and a worker whose script the Service Worker may answer starts unseeded (each one is named); ' +
    `${BLOCK}.`,
  early: 'it is a Shared Worker started before the browser told keploy which Service Workers the page\'s origin has (keploy asks as each document begins, ' +
    'and a document that begins while a document of the origin is registering a Service Worker, or that cannot read its Service Workers ' +
    'or its Web Locks, as a sandboxed one, is never told), and a Service Worker whose scope holds the worker\'s URL ' +
    `would see keploy's __keploy_worker mark in the script's URL, so keploy starts the worker as the app asked; ${BLOCK}.`,
  nested: 'it is a worker that a worker started, and Chromium and Firefox do not let keploy reach its script to put its seeding ahead of it; ' +
    'record and replay the test in WebKit to seed it.',
};

const UNPLACED: Record<Exclude<Unplaced, 'uncounted' | 'worker' | 'shared' | 'routed' | 'continued' | 'service' | 'controlled' | 'early' | 'nested'>, string> = {
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
 * storage (under its parent): the document's own frame, or the one it is in
 * (othersNow); by: for 'controlled', the address of the Service Worker that
 * may answer the worker's script ('' when keploy cannot read it).
 */
export function unplacedLine(name: string, at: string, why: Unplaced = 'popup', others = 0, by = ''): string {
  if (why === 'controlled') {
    return `keploy: in ${name}, the worker at ${at} draws the browser's own random numbers, ${KIDS}: ` +
      `a Service Worker${by === '' ? '' : ` (at ${by})`} may answer the worker's script, and it would see keploy's __keploy_worker mark in the script's URL, so keploy starts the worker as the app asked; ` +
      `${BLOCK}.`;
  }
  if (why === 'worker' || why === 'shared' || why === 'routed' || why === 'continued' || why === 'service' || why === 'early' || why === 'nested') {
    const what = why === 'shared' || why === 'early' || why === 'continued' ? 'Shared Worker' : why === 'service' ? 'Service Worker' : 'worker';
    return `keploy: in ${name}, the ${what} at ${at} draws the browser's own random numbers, ${why === 'service' ? 'so its draws may differ at replay' : KIDS}: ${UNREACHED[why]}`;
  }
  const n = Math.floor(Number(others));
  const reason = why === 'uncounted'
    ? 'it is a frame under a parent of another origin with no session storage (a sandboxed frame without allow-same-origin), or a frame inside one: ' +
      'keploy cannot count the documents that frame loads, so seeded, the next document there (a reload, or a frame the app puts in again at its place)' +
      (n > 0 ? ` or, at its path, one of the ${n} other frame(s) beside that frame` : '') + ' could draw the same numbers.'
    : UNPLACED[why];
  return `keploy: in ${name}, the document at ${at} drew the browser's own random numbers, so its draws may differ at replay: ${reason}`;
}

/**
 * The frame with no session storage that an 'uncounted' line names, and its
 * parent: frame is the document's own frame, and above how many frames up
 * from it that one is (initScript; 0 for its own). null when it has no
 * parent (a top document, or one further up than the top).
 */
export function besideOf(frame: Frame, above: number): [Frame, Frame] | null {
  let f: Frame | null = frame;
  for (let i = 0; i < above && f !== null; i++) f = f.parentFrame();
  const parent = f === null ? null : f.parentFrame();
  return f === null || parent === null ? null : [f, parent];
}

/**
 * How many other frames are beside that frame under its parent (besideOf)
 * now; 0, so the line names no other frame, when there is no such frame or
 * it is gone (its parent may have moved on to another document, which holds
 * other frames).
 * The fixture counts once the parent's parser has ended (its
 * DOMContentLoaded), or at the test's end if it has not: a frame draws as it
 * loads, and may draw and load while its parent's parser holds the frames
 * after it in its markup (behind a script it loads), so a count taken at
 * its draw, or at its own load, would depend on the network.
 */
export function othersNow(beside: [Frame, Frame] | null): number {
  return beside === null || beside[0].isDetached() ? 0 : beside[1].childFrames().length - 1;
}

/** A seed drawn afresh for a test's begin: 128 bits, as hex. */
export function freshSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * The stream a test's process draws Math.random from under seed (or, named,
 * another of its streams: a faker instance's): sfc32 over the SHA-256 of the
 * seed and the stream's name, 53 bits a draw, as Node's own Math.random
 * gives. A replay draws what its recording drew only while this stays the
 * same: a recording keeps the seed, not the numbers.
 */
export function processRandom(seed: string, name = 'Math.random'): () => number {
  const h = crypto.createHash('sha256').update(`${seed}\ntest process\n${name}`).digest();
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
 * Gives draw back, counting each of its draws under name in counts (the
 * test process's part of a test's note, note.ts).
 */
export function tally(counts: Map<string, number>, name: string, draw: () => number): () => number {
  return () => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return draw();
  };
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
  // What setAside holds for this seat: worker fixtures being set up.
  const aside = new Set<object>();
  asideNow = aside;
  const seeded = { random(): number { return preparing > 0 || aside.size > 0 ? own() : draw(); } }.random;
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

// The set the seat in place now (or the last one) takes setAside's holds
// from: each seat makes its own, so a hold never outlives its seat.
let asideNow = new Set<object>();

/**
 * Gives the process's own Math.random back, under the seat in place, until
 * the returned function is called (once or more): what runs meanwhile is the
 * worker's, not the test's. A worker fixture is set up in the first test that
 * asks for it, after that test's seat is in place, so its draws (a test
 * account made once for the worker's tests) would come from that test's
 * stream and shift the test's own draws: a replay in which another test is
 * the first to ask for it (one test alone, or after keploy set an earlier
 * test aside) would draw other numbers than its recording. With no seat in
 * place it holds nothing.
 */
export function setAside(): () => void {
  const held = asideNow;
  const hold = {};
  held.add(hold);
  return () => { held.delete(hold); };
}

/**
 * What a faker instance draws from: each of its draws calls next, for a
 * number in [0, 1), and its seed method calls seed.
 */
export type Randomizer = { next: () => number; seed: (...args: unknown[]) => unknown };

/**
 * The prebuilt faker instances a test file gets, each by its export's name;
 * problem: why none could be had where the file can import the package (''
 * when there is none to say).
 */
export type Fakers = { found: ReadonlyArray<readonly [string, Randomizer]>; problem: string };

/**
 * Whether file, a test file, runs as an ES module, as Node and Playwright
 * decide it: .mjs and .mts files do, .cjs and .cts files do not, and any
 * other does when the nearest package.json above it says "type": "module".
 */
export function esmFile(file: string): boolean {
  const ext = path.extname(file);
  if (ext === '.mjs' || ext === '.mts') return true;
  if (ext === '.cjs' || ext === '.cts') return false;
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    let text: string | null = null;
    try {
      text = fs.readFileSync(path.join(d, 'package.json'), 'utf8');
    } catch {
      text = null;
    }
    if (text !== null) {
      try {
        return (JSON.parse(text) as { type?: unknown } | null)?.type === 'module';
      } catch {
        return false;
      }
    }
    if (path.dirname(d) === d) return false;
  }
}

// The conditions Node resolves an import under.
const IMPORT_CONDITIONS: readonly string[] = ['node', 'import', 'module-sync', 'default'];

/**
 * The file a package's exports give its main entry under conditions, as Node
 * picks it: in a conditions object, the first key in the object's order that
 * is one of them and gives a file; in an array, the first entry that gives
 * one. null for none.
 */
export function exportOf(exp: unknown, conditions: readonly string[]): string | null {
  if (typeof exp === 'string') return exp;
  if (Array.isArray(exp)) {
    for (const e of exp) {
      const t = exportOf(e, conditions);
      if (t !== null) return t;
    }
    return null;
  }
  if (exp === null || typeof exp !== 'object') return null;
  const o = exp as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.some((k) => k.startsWith('.'))) return '.' in o ? exportOf(o['.'], conditions) : null;
  for (const k of keys) {
    if (!conditions.includes(k)) continue;
    const t = exportOf(o[k], conditions);
    if (t !== null) return t;
  }
  return null;
}

// What a faker instance draws from: faker 10's fakerCore.randomizer, faker 8
// and 9's _randomizer; null for a value that is no instance.
function randomizerOf(v: unknown): Randomizer | null {
  if (v === null || typeof v !== 'object') return null;
  let r: unknown;
  try {
    const o = v as { fakerCore?: { randomizer?: unknown } | null; _randomizer?: unknown };
    r = o.fakerCore?.randomizer ?? o._randomizer;
  } catch {
    return null;
  }
  if (r === null || typeof r !== 'object') return null;
  const x = r as Partial<Randomizer>;
  return typeof x.next === 'function' && typeof x.seed === 'function' ? x as Randomizer : null;
}

/**
 * The prebuilt instances a faker module exports, each once, by its export's
 * name, in the order of the names: the instances allFakers holds are those
 * its fakerXX exports name, so those names come first.
 */
export function fakersIn(mod: unknown): Array<[string, Randomizer]> {
  const out: Array<[string, Randomizer]> = [];
  if (mod === null || (typeof mod !== 'object' && typeof mod !== 'function')) return out;
  const seen = new Set<Randomizer>();
  const add = (name: string, from: Record<string, unknown>, k: string): void => {
    let v: unknown;
    try {
      v = from[k];
    } catch {
      return;
    }
    const r = randomizerOf(v);
    if (r !== null && !seen.has(r)) {
      seen.add(r);
      out.push([name, r]);
    }
  };
  const m = mod as Record<string, unknown>;
  for (const k of Object.keys(m).sort()) if (k !== 'allFakers') add(k, m, k);
  let all: unknown;
  try {
    all = m.allFakers;
  } catch {
    all = null;
  }
  if (all !== null && typeof all === 'object') {
    const a = all as Record<string, unknown>;
    for (const k of Object.keys(a).sort()) add(`allFakers.${k}`, a, k);
  }
  return out;
}

// The folder of the faker package that holds entry.
function rootOf(entry: string): string {
  for (let d = path.dirname(entry); ; d = path.dirname(d)) {
    try {
      if ((JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')) as { name?: unknown } | null)?.name === FAKER) return d;
    } catch {
      // No package.json here, or not one keploy can read: look further up.
    }
    if (path.dirname(d) === d) throw new Error(`no package.json of ${FAKER} holds ${entry}`);
  }
}

// What fakersOf found for each test file.
const fakersFound = new Map<string, Fakers>();

/**
 * The prebuilt instances of @faker-js/faker (faker, fakerDE, ...) that file,
 * a test file, gets when it imports the package, so that the test process can
 * seed them: those of the module the file's own import or require loads, as
 * the file resolves the package, loaded here when the file has not loaded it
 * yet. faker 10 is an ES module only, so a test file that Playwright runs as
 * CommonJS gets it through require, the very instances an ES module test
 * file imports; faker 9 has a CommonJS copy as well, so an ES module test
 * file's instances are its ES module ones. None, and no problem, when the
 * file cannot resolve the package; none, with the problem, when it resolves
 * it but its instances cannot be had (an ES module on a Node that cannot
 * require one).
 */
export function fakersOf(file: string): Fakers {
  const had = fakersFound.get(file);
  if (had !== undefined) return had;
  const f = findFakers(file);
  fakersFound.set(file, f);
  return f;
}

function findFakers(file: string): Fakers {
  const req = createRequire(file);
  const problem = (err: unknown): Fakers => ({ found: [], problem: err instanceof Error ? err.message : String(err) });
  let main: string;
  try {
    main = req.resolve(FAKER);
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'MODULE_NOT_FOUND' ? { found: [], problem: '' } : problem(err);
  }
  try {
    let entry = main;
    if (esmFile(file)) {
      const root = rootOf(main);
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { exports?: unknown; main?: unknown };
      const t = pkg.exports !== undefined ? exportOf(pkg.exports, IMPORT_CONDITIONS) : typeof pkg.main === 'string' ? pkg.main : 'index.js';
      if (t === null) throw new Error(`its package.json exports no file for import`);
      entry = path.resolve(root, t);
    }
    const found = fakersIn(req(entry));
    return { found, problem: found.length > 0 ? '' : 'it exports no instance keploy knows how to seed (faker 8, 9 and 10 do)' };
  } catch (err) {
    return problem(err);
  }
}

/**
 * The line a worker shows once for each reason it could not seed faker
 * where a test file can import it.
 */
export function fakerLine(problem: string): string {
  return `keploy: ${FAKER} is installed where the tests import it, but keploy cannot seed it (${pageAddress(problem)}), ` +
    'so what its instances make (a name, an email, an ID) differs from its recording\'s at replay while a mocked dependency answers with the recording\'s. ' +
    'Fix what the message names (an ES module needs Node 20.19, 22.12 or later to be loaded here), or seed it in a beforeEach (faker.seed(n)).';
}

// The faker instances the suite gave seedFaker outside a test's own code (as
// a file loads, in beforeAll, while a worker fixture is set up), each by the
// name it was given: every seat seats them.
const ownFakers = new Map<Randomizer, string>();

// The seat in place now, if any: seedFaker seats an instance on it at once.
let fakerSeatNow: { aside: Set<object>; add: (stream: string, r: Randomizer) => void } | null = null;

// The stream of a test's seed that an instance given to seedFaker under name
// draws from: never one of a prebuilt instance's, whatever the name.
function ownStream(name: string): string {
  return `${FAKER} own ${name}`;
}

/**
 * Puts the draws of each faker instance in found, and of each one the suite
 * gave seedFaker, on a stream of the test's seed named by the instance's
 * name, until the returned function puts its own back: so a replay makes the
 * names, emails and IDs its recording made, and one instance's draws move
 * neither another's nor Math.random's. An instance is seated once, by the
 * first name it has (found's before seedFaker's). Called just after
 * seatRandom: while setAside holds under that seat (a worker fixture being
 * set up), an instance draws its own. A test that seeds an instance itself
 * (faker.seed(n)) draws that instance's own from then on, seeded as it
 * asked. An instance's own generator does not move while seated, so outside
 * every test it goes on as if no test had drawn. counts, when given, counts
 * each seated draw under its stream's name (tally).
 */
export function seatFaker(seed: string, found: Fakers['found'], counts?: Map<string, number>): () => void {
  const aside = asideNow;
  const puts: Array<() => void> = [];
  const done = new Set<Randomizer>();
  const add = (stream: string, r: Randomizer): void => {
    if (done.has(r)) return;
    done.add(r);
    const own = r.next;
    const ownSeed = r.seed;
    const draw = counts !== undefined ? tally(counts, stream, processRandom(seed, stream)) : processRandom(seed, stream);
    const seated: Randomizer = {
      next(this: unknown): number { return aside.size > 0 ? Reflect.apply(own, this, []) as number : draw(); },
      seed(this: unknown, ...args: unknown[]): unknown {
        put();
        return Reflect.apply(ownSeed, this, args);
      },
    };
    const put = (): void => {
      if (r.next === seated.next) r.next = own;
      if (r.seed === seated.seed) r.seed = ownSeed;
    };
    r.next = seated.next;
    r.seed = seated.seed;
    puts.push(put);
  };
  for (const [name, r] of found) add(`${FAKER} ${name}`, r);
  for (const [r, name] of ownFakers) add(ownStream(name), r);
  const seat = { aside, add };
  fakerSeatNow = seat;
  return () => {
    if (fakerSeatNow === seat) fakerSeatNow = null;
    for (const p of puts) p();
  };
}

/**
 * Seeds a faker instance the suite makes itself (new Faker(...),
 * new SimpleFaker(...)) from each test's seed, as the instances
 * @faker-js/faker makes as it loads are seeded: from the test's begin to its
 * end, on a stream of the seed named by name, so a replay makes the names,
 * emails and IDs its recording made. Returns the instance:
 *
 *   const fakerMine = seedFaker(new Faker({ locale: [de, en] }), 'mine');
 *
 * Give each instance its own name: two given one name make the same data.
 * One given as a file loads, in beforeAll or while a worker fixture is set
 * up is seeded in every test after; one given in a test (its beforeEach, its
 * body, a test fixture) from then to that test's end. A test that seeds the
 * instance itself (fakerMine.seed(n)) draws it as it seeded it. Throws,
 * naming the next step, when instance is no faker instance this package can
 * seed or name is empty.
 */
export function seedFaker<T>(instance: T, name: string): T {
  const r = randomizerOf(instance);
  if (r === null) {
    throw new TypeError(`keploy: seedFaker(instance, name) was given no faker instance it can seed: give it an instance of ${FAKER} 8, 9 or 10 ` +
      '(new Faker(...) or new SimpleFaker(...))');
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('keploy: seedFaker(instance, name) was given no name: give each instance its own name (such as \'mine\'), ' +
      'which names the stream of each test\'s seed it draws from');
  }
  const seat = fakerSeatNow;
  if (seat === null || seat.aside.size > 0) ownFakers.set(r, name);
  seat?.add(ownStream(name), r);
  return instance;
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

// The query parameter that marks a worker's script URL with the worker's
// name in the seeding (initScript, workerMark); the fixture's route takes it
// off before the request leaves the browser.
export const WORKER_PARAM = '__keploy_worker';

// The BroadcastChannel, by the context's mark, on which the documents of a
// context say the scopes of the Service Worker registrations they make and
// find (initScript).
export const SW_CHANNEL = '__keploy_service_workers_';

// The Web Lock each register of a document holds, shared, from before the
// browser registers it until it settles, so that a document of the origin
// that begins meanwhile knows a registration may be coming (initScript).
export const SW_LOCK = 'keploy-sw-register';

// A browser script's streams: hash, a string's 128 bits (cyrb128), and
// stream, sfc32 over them, 32 random bits a call. A replay draws what its
// recording drew only while these stay the same.
const STREAM_JS = `  const imul = Math.imul;
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
`;

// A browser script's seeded Math.random, crypto.getRandomValues and
// crypto.randomUUID, each drawing from from(name) ('random', 'grv',
// 'uuid'): a stream, or null for the browser's own; and define, which
// keeps a property's flags. What the browser's own call throws in them
// reaches their caller as thrown(e) gives it (workerScript's: with no frame
// of keploy's seeding on its stack).
const DRAW_JS = `  const define = (o, name, value) => {
    const d = Object.getOwnPropertyDescriptor(o, name);
    Object.defineProperty(o, name, { value, writable: d ? d.writable : true, enumerable: d ? d.enumerable : false, configurable: true });
  };
  const fill = (next, u) => {
    for (let i = 0; i < u.length; i += 4) {
      let w = next();
      for (let j = 0; j < 4 && i + j < u.length; j++) { u[i + j] = w & 255; w >>>= 8; }
    }
  };
  const realRandom = Math.random;
  /* 53 bits, as the browser's own Math.random gives. */
  define(Math, 'random', { random() {
    const rnd = from('random');
    if (rnd === null) return realRandom();
    return ((rnd() >>> 5) * 67108864 + (rnd() >>> 6)) / 9007199254740992;
  } }.random);
  const C = typeof Crypto === 'function' ? Crypto.prototype : null;
  if (C && typeof C.getRandomValues === 'function') {
    const real = C.getRandomValues;
    define(C, 'getRandomValues', { getRandomValues(array) {
      /* The browser's own call first: it refuses what the browser refuses
         (a float array, more than 65536 bytes, a this that is no Crypto). */
      let out;
      try { out = real.call(this, array); } catch (e) { throw thrown(e); }
      const grv = from('grv');
      if (grv !== null) fill(grv, new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
      return out;
    } }.getRandomValues);
  }
  if (C && typeof C.randomUUID === 'function') {
    const realUUID = C.randomUUID;
    define(C, 'randomUUID', { randomUUID() {
      let own;
      try { own = realUUID.call(this); } catch (e) { throw thrown(e); }
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
`;

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
      const came = await Promise.allSettled(coming);
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
 * '') and, for 'uncounted', how many frames up from the document's own
 * frame the frame with no session storage is (0 for its own), so the
 * fixture can count the frames beside that one (othersNow).
 *
 * The path alone names the document in its frame: a replay may serve the
 * app at another host or port than its record did, and a query often
 * carries a time. A stream for each function keeps one's draws from
 * shifting another's: a timer's Math.random does not move the next
 * crypto.randomUUID.
 *
 * mark: the value by which firstScript marks a page's first document ('' for
 * none, so no document is marked).
 *
 * drawn: the name of a function the fixture exposed ('' for none) that
 * hears how a placed document drew: after each task in which it drew or
 * numbered a frame, once its place is known, with its place (the key its
 * streams are made from, without the seed), its address, how many times it
 * drew Math.random, crypto.getRandomValues and crypto.randomUUID, and how
 * many frames it numbered at each path (the note, note.ts).
 */
export function initScript(seed: string, report = '', mark = '', shared = true, drawn = ''): string {
  return `(() => {
  const seed = ${JSON.stringify(seed)};
  const mark = ${JSON.stringify(mark)};
  const shared = ${shared ? 'true' : 'false'};
  const g = globalThis;
${STREAM_JS}
  // The fixture's function that hears of a document with no place, taken
  // off the window so the page does not see it.
  let tell = null;
  ${report === '' ? '' : `try { const f = g[${JSON.stringify(report)}]; if (typeof f === 'function') tell = f; delete g[${JSON.stringify(report)}]; } catch (e) { tell = null; }`}
  // The fixture's function that hears how a placed document drew, taken
  // off the window the same way.
  let tellDrawn = null;
  ${drawn === '' ? '' : `try { const f = g[${JSON.stringify(drawn)}]; if (typeof f === 'function') tellDrawn = f; delete g[${JSON.stringify(drawn)}]; } catch (e) { tellDrawn = null; }`}
  const later = typeof g.queueMicrotask === 'function' ? g.queueMicrotask.bind(g) : null;
  // Tells the fixture how document state s drew so far, once its place is
  // known: a document whose place no one asked for yet is told when one
  // does (pageOf), so this never asks for it before the page script ran.
  const sendDrawn = (s) => {
    s.due = false;
    if (s.page === undefined) { s.wants = true; return; }
    if (s.page === null || tellDrawn === null || stale()) return;
    const k = (seed + '\\n' + s.page + '\\n' + s.place + '\\n' + s.loads + '\\n').split(seed + '\\n').join('');
    let at = '';
    try {
      const o = location.origin;
      at = o && o !== 'null' ? o + location.pathname : String(location.href).split(/[?#]/)[0];
    } catch (e) { at = ''; }
    const f = {};
    s.numbers.forEach((c, p) => { f[p] = c; });
    try { const r = tellDrawn(k, at, [s.n[0], s.n[1], s.n[2]], f); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {}
  };
  // Marks s as having drawn or numbered a frame: it is told at the end of
  // the task, once however many times it drew.
  const drew = (s) => {
    if (tellDrawn === null || s.due) return;
    s.due = true;
    if (later !== null) later(() => sendDrawn(s)); else sendDrawn(s);
  };
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
    drew(s);
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
    try {
      const p = g.parent;
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
    const s = { doc, place, loads, counted, kind, up, frame, given, page: undefined, first: false, uncounted: false, opened: [], workers: new Mp(), els: new WM(), held: 0, bound: new WM(), mo: null, numbers: new Mp(), counts: new Mp(), streams: null, n: [0, 0, 0], due: false, wants: false };
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
  // twice to a real server in a record).
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
        if (t !== null && !s.counted) s.uncounted = true;
        p = t === null || s.uncounted ? null : t + 'x';
      } else if (s.frame !== null) {
        const k = s.up.key();
        p = k === null ? null : k + s.frame;
      }
      s.page = p;
      if (s.wants) { s.wants = false; drew(s); }
    }
    return s.page;
  };
  // Why a document with no page has none: 'frame' for a frame its parent
  // cannot place, 'uncounted' for a frame under a parent of another origin
  // with no session storage, or one in such a frame, 'nostorage' for a top
  // document with no session storage, or a frame of its origin in one, else
  // ''. aboveFor: for 'uncounted', how many frames up from the document's
  // own frame that frame with no session storage is (0 for its own): the
  // fixture counts the frames beside it under its parent (othersNow).
  const whyOf = () => {
    const s = now();
    if (s.kind === 'top') return s.uncounted ? 'nostorage' : '';
    if (s.kind === 'other') return s.uncounted ? 'uncounted' : '';
    return s.frame === null ? 'frame' : s.up.why();
  };
  const aboveFor = () => {
    const s = now();
    return s.kind === 'frame' && s.frame !== null ? s.up.above() + 1 : 0;
  };
  const key = () => { const p = pageOf(); const s = now(); return p === null ? null : seed + '\\n' + p + '\\n' + s.place + '\\n' + s.loads + '\\n'; };
  let mine;
  try {
    // first: firstScript, in a page's first document, marks it as such
    // (its state, so a later document that takes over the window is not),
    // with the mark the fixture gave this script, which a page's own script
    // does not know.
    const d = Object.freeze({ key, why: whyOf, above: aboveFor, enter, opened: () => now().opened, first: (m) => { if (mark !== '' && m === mark) now().first = true; } });
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
        try { const r = tell(at, why, aboveFor()); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {}
      }
    }
    if (s.streams === false) return null;
    s.n[name === 'random' ? 0 : name === 'grv' ? 1 : 2]++;
    drew(s);
    return s.streams[name];
  };
  // A page's stacks show no URL keploy marked: an error goes on as it is.
  const thrown = (e) => e;
${DRAW_JS}
  const realOpen = g.open;
  if (typeof realOpen === 'function') {
    define(g, 'open', { open() {
      const w = realOpen.apply(this, arguments);
      try { if (!stale()) { const opened = now().opened; if (w && opened.indexOf(w) < 0) opened.push(w); } } catch (e) {}
      return w;
    } }.open);
  }
  // Workers. A Web Worker is named by its document's key, its script's
  // path and how many workers the document started at that path before
  // it; a Shared Worker, which the documents of a context share, by its
  // script's path and its name alone. The script URL the worker starts
  // with carries that name as a mark (workerMark), which the fixture's
  // route answers with the worker's seeding, which then loads the app's
  // own script from the URL the app asked for (workerRoutes, workerAnswer).
  // A worker keploy cannot mark (a blob: or data: URL, or a
  // marked URL the browser refuses), and a Shared Worker where the route
  // does not reach its script (shared: false, Firefox), starts as the app
  // asked and draws the browser's own numbers, and says so through report.
  // A worker of a document with no place starts as the app asked: the
  // document says so (its first draw is asked for here).
  const construct = Reflect.construct;
  const slice = Array.prototype.slice;
  const hex = (s) => hash(s).map((w) => (w + 4294967296).toString(16).slice(1)).join('');
  const addressOf = (u) => (u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname : u.protocol);
  // Service Workers. keploy cannot put its seeding ahead of a Service
  // Worker's script, so each registration the browser makes says so; one
  // Playwright blocks (serviceWorkers: 'block' answers register with no
  // registration) says nothing. A worker's script request reaches a Service
  // Worker, which would see keploy's mark: a Web Worker's through its
  // document's controller, a Shared Worker's through the Service Worker of
  // the registration whose scope its URL begins with. So a Shared Worker is
  // marked only when keploy knows that no registration's scope holds its
  // URL; one started before keploy knows, or one a known registration's
  // scope holds, starts as the app asked and says so (servedBy), as does a
  // worker of a controlled document. keploy knows the registrations of the
  // document's origin once, as the document begins, the browser has said that
  // no register of the origin's documents is in flight (none holds or asks for
  // keploy's Web Lock, SW_LOCK, which each register takes before the browser
  // registers it and lets go once it settles) and then, asked only after that,
  // which registrations the origin has. In that order a register is known
  // whenever it began: one that settled before the lock was read is among the
  // registrations, one in flight holds the lock, and one that began after the
  // lock was read is said on keploy's channel, which this document opened
  // before it read the lock. A document that finds the lock held, or that has
  // no Web Locks, never knows (its next document asks again). keploy keeps
  // what it knows current: each document of the context says on keploy's
  // channel the scope of each register it calls (before the browser
  // registers it) and of each registration that answer finds, and hears
  // what the others say. A context Playwright blocks
  // registers none, and keploy knows that as it begins (the context's first
  // document finds none: the fixture's context is a new one). A document with
  // no Service Workers (an insecure context) has none to know. A Service
  // Worker is named by its script's address ('' when keploy cannot read it):
  // the controller; else that of the registration with the longest scope
  // that holds the worker's URL: its active one, else its waiting one, else
  // its installing one, or the script this document's register named.
  const swAddress = (w) => { try { return addressOf(new U(String(w.scriptURL))); } catch (e) { return ''; } };
  // The registrations keploy knows of, by scope, and the scopes of those this
  // document's getRegistrations found (the browser's own word).
  const regs = new Map();
  const found = new Set();
  let known = false;
  let channel = null;
  let post = null;
  const apply = Reflect.apply;
  // With no channel, nothing is said.
  const say = (m) => { try { apply(post, channel, [m]); } catch (e) {} };
  let realRegister = null;
  try { realRegister = g.ServiceWorkerContainer.prototype.register; } catch (e) { realRegister = null; }
  // The document's Web Locks, as the browser gave them (null: none).
  let locks = null;
  let lockRequest = null;
  let lockQuery = null;
  try {
    locks = g.navigator.locks;
    lockRequest = locks.request;
    lockQuery = locks.query;
  } catch (e) { locks = null; }
  const LOCK = ${JSON.stringify(SW_LOCK)};
  // Takes keploy's lock for a register; what it gives lets it go. With no
  // Web Locks it takes none, and the documents that begin meanwhile never
  // know either way.
  const hold = () => {
    let free = () => {};
    try {
      const settled = new Promise((ok) => { free = ok; });
      // A request the browser refuses says nothing to the app.
      apply(lockRequest, locks, [LOCK, { mode: 'shared' }, () => settled]).catch(() => {});
    } catch (e) {
      // No lock to take.
    }
    return () => { free(); };
  };
  try {
    if (/Service Worker registration blocked by Playwright/.test(Function.prototype.toString.call(realRegister))) known = true;
  } catch (e) {
    // No register to read: as the browser's own.
  }
  if (shared) {
    try {
      const BC = g.BroadcastChannel;
      post = BC.prototype.postMessage;
      channel = new BC(${JSON.stringify(SW_CHANNEL)} + mark);
      // A message of another shape (another script's on this channel) is
      // let be: nothing it holds is read but a string scope and address.
      channel.onmessage = (e) => {
        const m = e.data;
        const scope = m !== null && typeof m === 'object' ? m.scope : undefined;
        if (typeof scope !== 'string') return;
        if (m.gone === true) {
          if (!found.has(scope)) regs.delete(scope);
        } else if (typeof m.at === 'string' && !regs.has(scope)) regs.set(scope, m.at);
      };
    } catch (e) {
      // No channel here: this document knows only its own.
    }
  }
  try {
    const proto = g.ServiceWorkerContainer.prototype;
    if (typeof realRegister === 'function') {
      define(proto, 'register', { register(url, options) {
        let at = '';
        let scope = '';
        try {
          const d = docNow();
          const base = d ? d.baseURI : location.href;
          const su = new U(String(url), base);
          at = addressOf(su);
          const sc = options !== null && typeof options === 'object' && options.scope !== undefined ? new U(String(options.scope), base) : new U('./', su);
          sc.hash = '';
          scope = sc.href;
        } catch (e) { scope = ''; }
        // Known before the browser registers it: here, and in each other
        // document of the context once it hears it; the lock first, so that
        // a document that begins after it is said finds the lock held.
        const free = hold();
        const had = regs.has(scope);
        if (!had) { regs.set(scope, at); say({ scope, at }); }
        let p;
        try { p = realRegister.apply(this, arguments); } catch (e) { free(); throw e; }
        try {
          p.then((r) => {
            free();
            if (!r) {
              // Playwright's block registered none: what this register held
              // goes, unless the browser found that registration.
              if (!found.has(scope)) { regs.delete(scope); say({ scope, gone: true }); }
              return;
            }
            if (tell !== null) { const t = tell(at, 'service', 0); if (t && typeof t.catch === 'function') t.catch(() => {}); }
          }, () => { free(); });
        } catch (e) {
          // A register that returned no promise: nothing to hear, nothing
          // in flight.
          free();
        }
        return p;
      } }.register);
    }
  } catch (e) {
    // No Service Workers here (an insecure context), or a prototype that
    // takes no property: its registrations say nothing.
  }
  try {
    const c = g.navigator.serviceWorker;
    if (c === undefined) known = true;
    else {
      // keploy's lock, held or asked for: a register in flight. One of the
      // app's own at that name counts too.
      const busy = (l) => l.name === LOCK;
      apply(lockQuery, locks, []).then((q) => {
        if (q.held.some(busy) || q.pending.some(busy)) return undefined;
        return c.getRegistrations().then((rs) => {
          for (const r of rs) {
            const s = String(r.scope);
            found.add(s);
            if (!regs.has(s)) {
              const a = swAddress(r.active || r.waiting || r.installing);
              regs.set(s, a);
              say({ scope: s, at: a });
            }
          }
          known = true;
        });
      }).catch(() => {});
    }
  } catch (e) {
    // No Service Worker can be read here (an opaque origin), or no Web Locks:
    // keploy does not know.
  }
  // The address of the Service Worker that may answer the script of a worker
  // at href ('' when keploy cannot read it); null when none may; false for
  // a Shared Worker started before keploy knows.
  const servedBy = (name, href) => {
    let c = null;
    try { c = g.navigator.serviceWorker.controller; } catch (e) { c = null; }
    if (c) return swAddress(c);
    if (name !== 'SharedWorker') return null;
    let best = '';
    let by = null;
    for (const [s, a] of regs) if (href.startsWith(s) && s.length > best.length) { best = s; by = a; }
    if (by !== null) return by;
    return known ? null : false;
  };
  const wrap = (name, tokenOf) => {
    const Real = g[name];
    if (typeof Real !== 'function') return;
    const W = { [name]: function (url) {
      // Called without new, it throws as the browser's own does.
      if (!new.target) return Real.apply(this, arguments);
      const args = slice.call(arguments);
      if (stale()) return construct(Real, args, new.target);
      let u = null;
      try {
        const d = docNow();
        u = new U(String(url), d ? d.baseURI : location.href);
      } catch (e) { u = null; }
      // A URL the browser cannot read: its own error.
      if (u === null) return construct(Real, args, new.target);
      const o = args[1];
      const module = o !== null && typeof o === 'object' && o.type === 'module';
      let at = '';
      try { at = addressOf(u); } catch (e) { at = '?'; }
      // Its token is taken whoever answers it: the next worker's place does
      // not hang on when a Service Worker came.
      let why = u.protocol !== 'http:' && u.protocol !== 'https:' ? 'worker' : tokenOf(u, o);
      const by = why !== null && why.length === 32 ? servedBy(name, u.href) : null;
      if (by !== null) why = by === false ? 'early' : 'controlled';
      if (why !== null && why.length === 32) {
        const h = u.href;
        const i = h.indexOf('#');
        const b = i < 0 ? h : h.slice(0, i);
        const m = b + (b.indexOf('?') < 0 ? '?' : '&') + ${JSON.stringify(WORKER_PARAM)} + '=' + (name === 'SharedWorker' ? (module ? 'x' : 's') : module ? 'm' : 'w') + '.' + why + (i < 0 ? '' : h.slice(i));
        try { return construct(Real, [m].concat(args.slice(1)), new.target); } catch (e) {
          // Refused with the mark (a Trusted Types policy): as the app asked.
        }
      }
      const w = construct(Real, args, new.target);
      if (why !== '' && tell !== null) {
        try { const r = tell(at, why === 'shared' || why === 'controlled' || why === 'early' ? why : 'worker', why === 'controlled' ? by : 0); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {}
      }
      return w;
    } }[name];
    try {
      W.prototype = Real.prototype;
      Object.defineProperty(Real.prototype, 'constructor', { value: W, writable: true, enumerable: false, configurable: true });
      Object.setPrototypeOf(W, Object.getPrototypeOf(Real));
      define(g, name, W);
    } catch (e) {
      // A window that takes no property: its workers draw their own.
    }
  };
  // A Web Worker's token, or '' for a document with no place (which says
  // so at its first draw, asked for here).
  wrap('Worker', (u) => {
    const k = key();
    if (k === null) { from('random'); return ''; }
    const s = now();
    const n = s.workers.get(u.pathname) || 0;
    s.workers.set(u.pathname, n + 1);
    return hex(k + 'worker\\n' + u.pathname + '\\n' + n);
  });
  // A Shared Worker's token: the same in every document of the context, so
  // that the documents still share one worker.
  wrap('SharedWorker', (u, o) => {
    if (!shared) return 'shared';
    const n = typeof o === 'string' ? o : o !== null && typeof o === 'object' && o.name !== undefined ? String(o.name) : '';
    return hex(seed + '\\nshared worker\\n' + u.pathname + '\\n' + n);
  });
})();
`;
}

/**
 * A worker's script URL, marked (initScript), read back: its kind ('w' a
 * classic Web Worker's script, 'm' a module Web Worker's, 's' a classic
 * Shared Worker's, 'x' a module Shared Worker's, 'p' the seeding that the
 * answer to 'm' imports, 't' a seeded Web Worker telling keploy the address
 * of a worker it started that keploy cannot mark: NESTED_JS), its token,
 * the instance n of a token ('p'; -1 for the others), and
 * the URL with no mark, as the app asked for it. null for a URL with no
 * mark keploy made.
 */
export type WorkerMark = { kind: 'w' | 'm' | 's' | 'x' | 'p' | 't'; token: string; n: number; url: string };

export function workerMark(href: string): WorkerMark | null {
  const i = href.indexOf('#');
  const b = i < 0 ? href : href.slice(0, i);
  const m = /[?&]__keploy_worker=([wmsxpt])\.([0-9a-f]{32})(?:\.(\d{1,9}))?$/.exec(b);
  if (m === null) return null;
  const kind = m[1] as WorkerMark['kind'];
  const numbered = kind === 'p';
  if (numbered !== (m[3] !== undefined)) return null;
  return { kind, token: m[2], n: numbered ? Number(m[3]) : -1, url: b.slice(0, m.index) + (i < 0 ? '' : href.slice(i)) };
}

/** url marked as kind, for the instance n of token (workerMark). */
export function markWorker(url: string, kind: WorkerMark['kind'], token: string, n = -1): string {
  const i = url.indexOf('#');
  const b = i < 0 ? url : url.slice(0, i);
  return `${b}${b.includes('?') ? '&' : '?'}${WORKER_PARAM}=${kind}.${token}${n >= 0 ? `.${n}` : ''}${i < 0 ? '' : url.slice(i)}`;
}

/**
 * The seeding of a worker's global scope, run before the app's script:
 * one stream for each of Math.random, crypto.getRandomValues and
 * crypto.randomUUID, from the worker's token (initScript) and n, the
 * instance of the token (a Shared Worker started again after its documents
 * closed is the next). Its location (href, search, toString) does not show
 * the mark kind.token the worker's URL carries; the app's script runs at
 * its own URL (workerAnswer), and its fetch and Request take the mark off
 * the URLs and referrers they would send. An Error's or a DOMException's stack read
 * through its prototype's getter (Firefox's, whose stacks go on through
 * the code that queued what runs) leaves out each frame at a URL keploy
 * marked: keploy's own code. An error the browser's own call throws in a
 * seeded function or in the location's getters (a float array, a this that
 * is no Crypto or location) reaches its caller with none of the seeding's
 * frames on the stack it keeps (V8's and WebKit's).
 */
export function workerScript(token: string, n: number, kind: 'w' | 'm' | 's' | 'x', reach = false): string {
  return `(() => {
  const g = globalThis;
  const k = ${JSON.stringify(`${token}\n${n}\n`)};
${STREAM_JS}
  const streams = { random: stream(k + 'Math.random'), grv: stream(k + 'crypto.getRandomValues'), uuid: stream(k + 'crypto.randomUUID') };
  const from = (name) => streams[name];
  // keploy's seeding runs at a URL keploy marked (a query's mark, or a
  // data: module's media type parameter: workerAnswer). An error the
  // browser's own call throws in a seeded function or getter keeps, in V8
  // and WebKit, a stack of its own, made as it was thrown, with the seeding's
  // frames: they are left out of it before it reaches the caller, and a
  // stack with none, or that is no string, stays as it was.
  const marked = new RegExp(${JSON.stringify(`[?&;]${WORKER_PARAM}=`)});
  const unmark = (s) => s.split('\\n').filter((l) => !marked.test(l)).join('\\n');
  const thrown = (e) => {
    try {
      const d = Object.getOwnPropertyDescriptor(e, 'stack');
      const s = d.get ? d.get.call(e) : d.value;
      if (typeof s === 'string' && marked.test(s)) {
        if (d.get) d.set.call(e, unmark(s));
        else Object.defineProperty(e, 'stack', { value: unmark(s) });
      }
    } catch (x) {}
    return e;
  };
${DRAW_JS}
  const M = ${JSON.stringify(`${WORKER_PARAM}=${kind}.${token}`)};
  const strip = (h) => {
    const s = String(h);
    const i = s.indexOf('#');
    const b = i < 0 ? s : s.slice(0, i);
    for (const c of ['?', '&']) if (b.endsWith(c + M)) return b.slice(0, b.length - M.length - 1) + (i < 0 ? '' : s.slice(i));
    return s;
  };
  // The worker's code resolves a URL against its script's URL, keploy's
  // mark and all, and the browser names that URL as the referrer of the
  // worker's requests. A fetch or a Request at the script's own URL (an
  // empty URL, a fragment alone) asks for it with no mark, and a fetch whose
  // referrer the browser would pick (none given, by the init or by a
  // Request made with the default policy) names the script's URL with no
  // mark. What the browser's own fetch or Request refuses reaches the
  // caller as thrown(e) gives it.
  let at = '';
  try { at = String(g.location.href); } catch (e) {}
  const own = strip(at);
  const F = g.fetch;
  const Q = g.Request;
  if (own !== at && typeof F === 'function' && typeof Q === 'function') {
    const U = g.URL;
    const unmarked = (u) => {
      if (typeof u !== 'string') return u;
      try { const h = new U(u, at).href; const s = strip(h); return s === h ? u : s; } catch (e) { return u; }
    };
    const named = (o) => (o === undefined || o === null ? { referrer: own }
      : typeof o === 'object' || typeof o === 'function' ? new Proxy(o, { get: (t, k) => { const v = Reflect.get(t, k); return k === 'referrer' && v === undefined ? own : v; } }) : o);
    const R = new Proxy(Q, { construct: (t, a, n) => { if (a.length > 0) a[0] = unmarked(a[0]); try { return Reflect.construct(t, a, n); } catch (e) { throw thrown(e); } } });
    define(g, 'Request', R);
    define(Q.prototype, 'constructor', R);
    define(g, 'fetch', { fetch(input, ...more) {
      const pick = !(input instanceof Q) || (input.referrer === 'about:client' && input.referrerPolicy === '');
      const args = [unmarked(input), ...(pick ? [named(more[0]), ...more.slice(1)] : more)];
      return F.apply(this, args).then(undefined, (e) => { throw thrown(e); });
    } }.fetch);
  }
  const L = typeof WorkerLocation === 'function' ? WorkerLocation.prototype : null;
  if (L) {
    for (const name of ['href', 'search']) {
      try {
        const d = Object.getOwnPropertyDescriptor(L, name);
        if (!d || typeof d.get !== 'function') continue;
        const get = d.get;
        const read = (o) => { try { return get.call(o); } catch (e) { throw thrown(e); } };
        const v = name === 'href'
          ? { get href() { return strip(read(this)); } }
          : { get search() { const s = read(this); const i = s.indexOf(M); if (i < 1) return s; const t = s.slice(0, i - 1); return t === '?' ? '' : t; } };
        Object.defineProperty(L, name, { get: Object.getOwnPropertyDescriptor(v, name).get, set: d.set, enumerable: d.enumerable, configurable: true });
      } catch (e) {}
    }
    try {
      const t = L.toString;
      if (typeof t === 'function') define(L, 'toString', { toString() { let h; try { h = t.call(this); } catch (e) { throw thrown(e); } return strip(h); } }.toString);
    } catch (e) {}
  }
  // Firefox reads a stack through its prototype's getter, and the stack
  // goes on through the code that queued what runs: keploy's answer, at a
  // URL keploy marked. A stack read here shows no frame at such a URL.
  for (const C of [g.Error, g.DOMException]) {
    try {
      const d = Object.getOwnPropertyDescriptor(C.prototype, 'stack');
      const get = d.get;
      if (typeof get !== 'function') continue;
      const v = { get stack() { const s = get.call(this); return typeof s === 'string' ? unmark(s) : s; } };
      Object.defineProperty(C.prototype, 'stack', { get: Object.getOwnPropertyDescriptor(v, 'stack').get, set: d.set, enumerable: d.enumerable, configurable: true });
    } catch (e) {}
  }
${kind === 'w' || kind === 'm' ? NESTED_JS(token, reach) : ''}})();
`;
}

/**
 * A Web Worker's seeding of the Web Workers it starts (workerScript). Where
 * the context's route reaches their scripts (reach: WebKit), each is named by this worker's key, its script's path and how many workers
 * this worker started at that path before it, and its script URL, resolved
 * against the URL the app asked for, carries keploy's mark, which the
 * context's route answers with its seeding (workerAnswer), as a page's
 * workers are. Chromium and Firefox let the route reach none of them, so
 * there each starts as the app asked, with no mark ('nested'), as does one
 * keploy cannot mark (a blob: or data: URL, or a marked URL the browser
 * refuses: 'worker'). For each of these this worker tells keploy why and
 * the address: it posts them to its own script's URL marked t (kind t), a
 * request keploy's route answers itself (workerRoutes), so the app's server
 * never sees it. A Shared Worker's scope is left as it is.
 */
const NESTED_JS = (token: string, reach: boolean): string => `  const RW = g.Worker;
  if (typeof RW === 'function') {
    const U = g.URL;
    const hex = (s) => hash(s).map((w) => (w + 4294967296).toString(16).slice(1)).join('');
    const started = new Map();
    const mark = (h, kind, t) => {
      const i = h.indexOf('#');
      const b = i < 0 ? h : h.slice(0, i);
      return b + (b.indexOf('?') < 0 ? '?' : '&') + ${JSON.stringify(`${WORKER_PARAM}=`)} + kind + '.' + t + (i < 0 ? '' : h.slice(i));
    };
    const tell = (why, where) => {
      try { F.call(g, mark(own, 't', ${JSON.stringify(token)}), { method: 'POST', body: JSON.stringify([why, where]) }).then(undefined, () => {}); } catch (e) {}
    };
    const W = { Worker: function (url) {
      // Called without new, it throws as the browser's own does.
      if (!new.target) return RW.apply(this, arguments);
      const args = Array.prototype.slice.call(arguments);
      let u = null;
      try { u = new U(String(url), own); } catch (e) { u = null; }
      // A URL the browser cannot read: its own error.
      if (u === null) return Reflect.construct(RW, args, new.target);
      const web = u.protocol === 'http:' || u.protocol === 'https:';
      if (web) {
        const n = started.get(u.pathname) || 0;
        started.set(u.pathname, n + 1);
        const o = args[1];
        const m = ${reach ? 'true' : 'false'} && mark(u.href, o !== null && typeof o === 'object' && o.type === 'module' ? 'm' : 'w', hex(k + 'worker\\n' + u.pathname + '\\n' + n));
        if (m) {
          try { return Reflect.construct(RW, [m].concat(args.slice(1)), new.target); } catch (e) {
            // Refused with the mark (a Trusted Types policy): as the app asked.
          }
        }
      }
      const w = Reflect.construct(RW, args, new.target);
      tell(web && !${reach ? 'true' : 'false'} ? 'nested' : 'worker', web ? u.origin + u.pathname : u.protocol);
      return w;
    } }.Worker;
    try {
      W.prototype = RW.prototype;
      Object.defineProperty(RW.prototype, 'constructor', { value: W, writable: true, enumerable: false, configurable: true });
      Object.setPrototypeOf(W, Object.getPrototypeOf(RW));
      define(g, 'Worker', W);
    } catch (e) {
      // A scope that takes no property: its workers draw their own.
    }
  }
`;

/**
 * Whether a module Shared Worker answered with these headers may import a
 * data: module: each Content-Security-Policy that names a source list for
 * its scripts (script-src-elem, else script-src, else default-src) or for
 * its worker's loads (worker-src, else child-src, else script-src, else
 * default-src) lists data: in it.
 */
export function cspAllowsData(headers: Record<string, string>): boolean {
  const v = headers['content-security-policy'];
  if (v === undefined) return true;
  for (const policy of v.split(/[,\n]/)) {
    const ds = new Map<string, string[]>();
    for (const d of policy.split(';')) {
      const t = d.trim().split(/\s+/).filter((x) => x !== '');
      if (t.length > 0 && !ds.has(t[0].toLowerCase())) ds.set(t[0].toLowerCase(), t.slice(1).map((x) => x.toLowerCase()));
    }
    const first = (...names: string[]): string[] | undefined => names.map((x) => ds.get(x)).find((x) => x !== undefined);
    for (const list of [first('script-src-elem', 'script-src', 'default-src'), first('worker-src', 'child-src', 'script-src', 'default-src')]) {
      if (list !== undefined && !list.includes('data:')) return false;
    }
  }
  return true;
}

/**
 * keploy's answer to a marked worker script ('w', 'm', 's' or 'x', for the
 * instance n of token): the worker's seeding, then the app's own script,
 * loaded from own, the URL the app asked for, with no mark. The app's
 * script so runs at its own URL: its import.meta.url, the URLs its imports
 * resolve against and a stack trace through it show no mark, and the
 * worker's location hides the one its script URL carries (workerScript).
 * No code of the answer's is on the stack when the app's code runs: a
 * classic worker imports the app's script (importScripts) after its
 * seeding, in a microtask the answer queues, which runs as the answer ends,
 * before the worker takes any message or connection, and reports what the
 * app's script throws as the worker's own error, as an uncaught one at its
 * top level is (a Firefox stack, which goes on through the code that queued
 * it, leaves the answer's frames out: workerScript). A module Web Worker
 * imports its seeding (the route answers
 * that import, marked 'p') and then the app's script. Chromium and WebKit
 * let the route reach none of what a Shared Worker loads after its script,
 * so a module Shared Worker imports its seeding as a data: module (its
 * media type carries keploy's mark as a parameter, so a stack leaves the
 * seeding's frames out: workerScript), which
 * runs before every module the app's script imports; where its policy
 * refuses data: scripts (dataOk false), its seeding runs in the answer
 * itself, which then imports the app's script (import()), and holds each
 * connect event that comes before the app's script has run, to give it, in
 * order, each in a microtask of its own, to the handlers the app's script
 * sets.
 */
export function workerAnswer(token: string, n: number, kind: 'w' | 'm' | 's' | 'x', own: string, dataOk = true, reach = false): string {
  const url = JSON.stringify(own);
  if (kind === 'w' || kind === 's') return `${workerScript(token, n, kind, reach)}queueMicrotask(importScripts.bind(globalThis, ${url}));\n`;
  if (kind === 'm') return `import ${JSON.stringify(markWorker(own, 'p', token, n))};\nimport ${url};\n`;
  const seeding = workerScript(token, n, 'x');
  if (dataOk) return `import ${JSON.stringify(`data:text/javascript;${WORKER_PARAM}=x.${token};base64,${Buffer.from(seeding).toString('base64')}`)};\nimport ${url};\n`;
  return `${seeding}const held = [];
const hold = (e) => { held.push(e); };
addEventListener('connect', hold);
try {
  await import(${url});
} finally {
  removeEventListener('connect', hold);
  for (const e of held) queueMicrotask(dispatchEvent.bind(globalThis, new MessageEvent('connect', { data: e.data, origin: e.origin, lastEventId: e.lastEventId, source: e.source, ports: e.ports })));
}
`;
}

/**
 * Whether the browser asks for r as a worker's script (a worker's own, or
 * the seeding a module Web Worker's answer imports), not as a request the
 * worker's code makes. A worker's code resolves URLs against its script's
 * URL, so one that resolves to that URL (fetch(''), a fragment alone)
 * carries keploy's mark too. Firefox and WebKit show the route the
 * request's destination (sec-fetch-dest: worker or sharedworker for a
 * worker's script, script for importScripts, empty for fetch and
 * XMLHttpRequest; WebKit types a worker's script xhr). Chromium shows it
 * none, and types a worker's script script, importScripts other, fetch
 * fetch and XMLHttpRequest xhr.
 */
function workerScriptLoad(r: Request): boolean {
  const dest = r.headers()['sec-fetch-dest'];
  if (dest !== undefined) return dest === 'worker' || dest === 'sharedworker';
  return r.resourceType() === 'script';
}

/** What the fixture hears from workerRoutes. */
export type WorkerHooks = {
  /** The route answered this request whole: none of it is in flight. */
  answered?: (r: Request) => void;
  /**
   * A route of the test's own answered the script of the worker at at (its
   * origin and path) itself ('routed'), or sent a Shared Worker's on with
   * options of its own ('continued'): it runs unseeded, at its marked URL.
   */
  routed?: (at: string, why: 'routed' | 'continued') => void;
  /**
   * A seeded Web Worker started a worker at at (its origin and path, or its
   * scheme: blob:, data:) that keploy cannot mark ('worker') or whose script
   * the route does not reach ('nested'), which so runs unseeded.
   */
  unmarked?: (at: string, why: 'worker' | 'nested') => void;
};

/** What keploy's routes go on: the test's context, or one of its pages. */
type Routes = Pick<BrowserContext, 'route' | 'unroute' | 'unrouteAll'>;

/**
 * Keeps handler at url ahead of every route the test adds to target after
 * it (route, and routeFromHAR, which adds its own through route): each time
 * one is added, keploy's is added again, ahead of it, before the one it
 * replaces is taken off, so no request finds neither. After the test's
 * unrouteAll, again comes first, then keploy's. Playwright runs a page's
 * routes before its context's, and the last added first.
 */
function keepFirst(target: Routes, url: (u: URL) => boolean, handler: (route: Route) => Promise<void>, again: () => Promise<unknown> = async () => {}): Promise<void> {
  const route = target.route;
  const unrouteAll = target.unrouteAll;
  let now: ((route: Route) => Promise<void>) | null = null;
  const add = async (): Promise<void> => {
    const h = (r: Route): Promise<void> => handler(r);
    const was = now;
    now = h;
    await route.call(target, url, h);
    if (was !== null) await target.unroute(url, was);
  };
  target.route = async function (this: Routes, ...args: Parameters<Routes['route']>) {
    const added = route.apply(this, args);
    const ahead = add();
    try {
      return await added;
    } finally {
      await ahead.catch(() => {});
    }
  } as Routes['route'];
  target.unrouteAll = async function (this: Routes, ...args: Parameters<Routes['unrouteAll']>) {
    await unrouteAll.apply(this, args);
    await again();
    await add();
  } as Routes['unrouteAll'];
  return add();
}

/** What a test's route.continue or route.fallback asks a request be sent with. */
type Asked = NonNullable<Parameters<Route['continue']>[0]>;

/**
 * Whether headers a and b are the same: each name, in any case, with the
 * same value (Playwright sends no header whose value is undefined).
 */
function sameHeaders(a: Record<string, string>, b: Record<string, string>): boolean {
  const low = (h: Record<string, string>): Map<string, string> =>
    new Map(Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const x = low(a);
  const y = low(b);
  return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
}

/**
 * Answers each marked worker script the test's context asks for with
 * workerAnswer, under the status and headers the app's server answered for
 * the script with no mark (a worker's policy comes from its script's
 * answer), and a module Web Worker's seeding (marked 'p') with
 * workerScript. So the app's server is asked for a worker's script twice:
 * here, for that answer, and by the worker, for the app's script. An answer
 * that is not ok goes to the worker as the server gave it; when keploy
 * cannot fetch the script, the worker gets its seeding with no header of the
 * app's and loads the app's script itself, as the browser would. Each
 * instance of a token (a Shared Worker started again) is the next n. Each
 * request it fulfills is answered: Chromium reports no end for a Shared
 * Worker's script, as Playwright does not follow Shared Workers. Only the
 * browser's load of a worker's script is answered so (workerScriptLoad): a
 * request the worker's own code makes at its script's marked URL (an
 * XMLHttpRequest's: its fetch and Request ask for no mark, workerScript)
 * goes on to the test's routes and the app's server with the mark taken off
 * (the URL the app's code meant, as the worker's location shows it), and
 * starts no instance of the token. A seeded Web Worker's word of a worker it
 * started that keploy cannot mark (marked t: NESTED_JS) is answered here, with
 * no body, and heard (unmarked); it reaches no route of the test's and not
 * the app's server.
 *
 * keploy's route comes first, ahead of every route the test adds to its
 * context or to one of its pages (keepFirst), so no route of the test's sees
 * the mark: it hands a worker's script load on to the test's routes at the
 * URL the app asked for, with the route's continue answering it as above (a
 * continued script is the app's server's, with keploy's seeding ahead of
 * it). A route of the test's that answers it itself (fulfill) answers it so,
 * unseeded, and the test hears of it (routed); one that aborts it aborts
 * it. One that falls back, or none, leaves it to keploy's last route, the
 * context's first, which answers it as above, at the URL a fallback gave it
 * too. What the test's continue and fallbacks ask (a URL, method, headers or
 * post data of their own) is what keploy's fetch of the script sends, and a
 * Web Worker's seeding loads the app's script through the test's routes
 * again, so they ask the same of it. A Shared Worker's seeding cannot
 * (Chromium and WebKit route none of its loads): one whose script the
 * test's routes asked for otherwise than the browser sent it gets the answer
 * to what they asked for, whole, unseeded, and the test hears of it
 * (routed, 'continued').
 */
export async function workerRoutes(context: BrowserContext, hooks: WorkerHooks = {}, reach = false): Promise<void> {
  const counts = new Map<string, number>();
  // The answer's headers, but its encoding and length: the body given is
  // keploy's, of another length.
  const headersOf = (h: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (k !== 'content-encoding' && k !== 'content-length') out[k] = v;
    return out;
  };
  // The worker script loads handed on to the test's routes: each one's mark,
  // the route's own fulfill, the headers the browser sent it with, and what
  // the test's routes asked of it (their continue's and fallbacks' options);
  // and the URLs it may reach the last route at (the app's, or one a
  // fallback of the test's gave it).
  type Handed = { m: WorkerMark; fulfill: Route['fulfill']; sent: Record<string, string>; asked: Asked };
  const handed = new WeakMap<Request, Handed>();
  const urls = new Set<string>();
  const ask = (h: Handed, o: Asked | undefined): void => {
    for (const [k, v] of Object.entries(o ?? {})) if (v !== undefined) (h.asked as Record<string, unknown>)[k] = v;
  };
  // Whether the test's routes asked for a worker's script otherwise than the
  // browser sent it: a URL, method or post data of their own, or headers
  // other than the browser's.
  const otherwise = (h: Handed): boolean => Object.entries(h.asked)
    .some(([k, v]) => k !== 'headers' || !sameHeaders(v as Record<string, string>, h.sent));
  // A route's fetch with o is the request the test's routes asked for: o's
  // URL, method, headers and post data, or the request's (the URL the app
  // asked for, or one a fallback gave, and what fallbacks gave it).
  const answer = async (route: Route, m: WorkerMark, own: Route['fulfill'], h?: Handed, o: Asked = {}): Promise<void> => {
    const fulfill = async (o: Parameters<Route['fulfill']>[0]): Promise<void> => {
      await own(o);
      hooks.answered?.(route.request());
    };
    if (m.kind === 'p') {
      await fulfill({ status: 200, contentType: 'text/javascript', body: workerScript(m.token, m.n, 'm', reach) });
      return;
    }
    const n = counts.get(m.token) ?? 0;
    counts.set(m.token, n + 1);
    // Chromium and WebKit route nothing a Shared Worker loads after its
    // script, so its seeding's load of the app's script goes out as the
    // browser asks: one the test's routes asked for otherwise gets what they
    // asked for, whole, unseeded, and is named.
    const whole = (m.kind === 's' || m.kind === 'x') && h !== undefined && otherwise(h);
    let status = 200;
    let headers: Record<string, string> = { 'content-type': 'text/javascript' };
    try {
      const got = await route.fetch(o);
      if (whole || !got.ok()) {
        await fulfill({ status: got.status(), headers: headersOf(got.headers()), body: await got.body() });
        if (whole) {
          const u = new URL(m.url);
          hooks.routed?.(u.origin + u.pathname, 'continued');
        }
        return;
      }
      status = got.status();
      headers = headersOf(got.headers());
    } catch {
      // The worker loads the app's script itself, and fails as it would.
    }
    await fulfill({ status, headers, body: workerAnswer(m.token, n, m.kind as 'w' | 'm' | 's' | 'x', m.url, cspAllowsData(headers), reach) });
  };
  const first = async (route: Route): Promise<void> => {
    const r = route.request();
    const m = workerMark(r.url());
    if (m === null) {
      await route.fallback();
      return;
    }
    // A seeded Web Worker's word of a worker keploy cannot mark: heard, then
    // answered here, so it never leaves the browser.
    if (m.kind === 't') {
      let said: unknown = null;
      try { said = JSON.parse(r.postData() ?? ''); } catch { said = null; }
      if (Array.isArray(said) && (said[0] === 'worker' || said[0] === 'nested') && typeof said[1] === 'string' && said[1] !== '') hooks.unmarked?.(said[1], said[0]);
      await route.fulfill({ status: 204 });
      hooks.answered?.(r);
      return;
    }
    if (!workerScriptLoad(r)) {
      await route.fallback({ url: m.url });
      return;
    }
    const own = route.fulfill.bind(route);
    if (m.kind === 'p') {
      await answer(route, m, own);
      return;
    }
    const h: Handed = { m, fulfill: own, sent: r.headers(), asked: {} };
    handed.set(r, h);
    urls.add(new URL(m.url).href);
    const fallback = route.fallback.bind(route);
    route.continue = async (o) => {
      ask(h, o);
      await answer(route, m, own, h, o);
    };
    route.fallback = async (o) => {
      ask(h, o);
      if (o?.url !== undefined) {
        try {
          urls.add(new URL(o.url).href);
        } catch {
          // Not a URL: Playwright refuses it.
        }
      }
      await fallback(o);
    };
    route.fulfill = async (o) => {
      const u = new URL(m.url);
      hooks.routed?.(u.origin + u.pathname, 'routed');
      await own(o);
    };
    await fallback({ url: m.url });
  };
  const last = async (route: Route): Promise<void> => {
    const h = handed.get(route.request());
    if (h === undefined) {
      await route.fallback();
      return;
    }
    await answer(route, h.m, h.fulfill, h);
  };
  const marked = (u: URL): boolean => u.searchParams.has(WORKER_PARAM);
  const lastUrl = (u: URL): boolean => urls.has(u.href);
  const route = context.route;
  const addLast = async (): Promise<void> => {
    await route.call(context, lastUrl, last);
  };
  await addLast();
  await keepFirst(context, marked, first, addLast);
  const onPage = (p: Page): void => {
    keepFirst(p, marked, first).catch(() => {
      // A page that closed as it opened: none of its requests is left.
    });
  };
  context.pages().forEach(onPage);
  context.on('page', onPage);
}
