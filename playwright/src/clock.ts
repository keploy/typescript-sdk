// The test process's clock, held per test, when a suite asks for it. A suite
// that stamps its test data with the time in the test process (a lead named
// `E2E Lead ${Date.now()}`) sends other data each run, while a mocked
// dependency answers with the recording's. keploy moves the run's clock to
// each test's recorded begin at replay, but a read inside the test is still
// off its recording's by as much as the replay ran faster or slower to it.
// Held, the clock reads the test's own code makes (Date.now(), new Date(),
// Date()) read the test's recorded start, one millisecond later at each read.
// Record and replay read the same instants, as long as the test reads the
// clock in the same order.
//
// The hold is off unless asked for: KEPLOY_HOLD_CLOCK=on for the run, or the
// option keployHoldClock: true for a project, a file or a group. Off, nothing
// here runs and a begin's seed is as before.
//
// The start travels in the test's seed, which keploy keeps with the test's
// recording and answers at replay: the seed a held begin sends is 32 hex
// digits of random bits and then the start, in milliseconds since the epoch,
// as 12 hex digits. A seed of any other form (a recording made with the clock
// not held) carries no start, and the test reads keploy's run clock.
//
// Only the test's code reads the held clock: a read whose nearest caller is
// Node's own code, Playwright's (its timeouts, its traces, the cookies of its
// API requests) or this package's reads the real one, and so does a worker
// fixture while it is set up. Playwright's waits and timeouts run on the real
// clock (and on monotonic time), so they are not changed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asideSet } from './random';

export const ENV_HOLD_CLOCK = 'KEPLOY_HOLD_CLOCK';

/** The option that holds the clock for a project, a file or a group. */
export const OPTION_HOLD_CLOCK = 'keployHoldClock';

export type Holding = { mode: 'on' } | { mode: 'off' } | { mode: 'unset' } | { mode: 'refused'; refusal: string };

/** What the environment says of the hold: on, off, or nothing. */
export function holdingFromEnv(env: NodeJS.ProcessEnv): Holding {
  const v = (env[ENV_HOLD_CLOCK] ?? '').trim();
  const l = v.toLowerCase();
  if (l === '') return { mode: 'unset' };
  if (l === 'on' || l === '1' || l === 'true') return { mode: 'on' };
  if (l === 'off' || l === '0' || l === 'false') return { mode: 'off' };
  return {
    mode: 'refused',
    refusal: `keploy: ${ENV_HOLD_CLOCK}=${JSON.stringify(v)} is neither on nor off; set it to on to hold the clock the test's code reads per test, ` +
      'or unset it to leave the test process on keploy\'s run clock',
  };
}

/**
 * Whether a test's clock is held: never under KEPLOY_HOLD_CLOCK=off; else as
 * its option says, when set; else when KEPLOY_HOLD_CLOCK=on.
 */
export function holds(env: Holding, option: boolean | undefined): boolean {
  if (env.mode === 'off') return false;
  if (option !== undefined) return option;
  return env.mode === 'on';
}

// The seed's form that carries the start: RANDOM_DIGITS of random bits, then
// START_DIGITS of the start.
const RANDOM_DIGITS = 32;
const START_DIGITS = 12;
export const SEED_WITH_START_DIGITS = RANDOM_DIGITS + START_DIGITS;
// A start keploy answers is believed only between these: a seed of the form
// whose last digits are not a time is no start.
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2200, 0, 1);

/** random (32 hex digits) with the start appended, as a held begin sends it. */
export function seedWithStart(random: string, start: number): string {
  if (random.length !== RANDOM_DIGITS || !Number.isSafeInteger(start) || start < EARLIEST || start >= LATEST) return random;
  return random + start.toString(16).padStart(START_DIGITS, '0');
}

/** The start a seed carries, or null for a seed that carries none. */
export function startOf(seed: string): number | null {
  if (seed.length !== SEED_WITH_START_DIGITS || !/^[0-9a-f]+$/.test(seed)) return null;
  const start = parseInt(seed.slice(RANDOM_DIGITS), 16);
  return start >= EARLIEST && start < LATEST ? start : null;
}

/** The real clock, as this module found it: what a held begin stamps its start with. */
export const wallNow: () => number = Date.now;

/** The line a worker shows once, at the first test whose clock it holds. */
export const HELD_LINE = 'keploy: each test\'s clock in the test process is held, as asked: the clock reads its own code makes (Date.now(), new Date(), Date()) ' +
  'read its recording\'s start, one millisecond later at each read, from its begin to its end, so data a test stamps with the time is its recording\'s at replay; ' +
  'Node\'s and Playwright\'s own reads, its waits and its timeouts keep the real clock, and so do performance.now(), process.hrtime() and a worker fixture while it is set up. ' +
  'A test that waits on its own clock in a loop sees one millisecond pass at each read. ' +
  `To keep a test's real clock, set use: { ${OPTION_HOLD_CLOCK}: false } for it; ${ENV_HOLD_CLOCK}=off keeps every test's.`;

/** Why a test whose hold was asked for reads keploy's run clock. */
export type Unheld = 'unseeded' | 'no seed' | 'no start';

/** The line a test shows when its clock was to be held and is not. */
export function unheldLine(name: string, why: Unheld): string {
  const because = why === 'unseeded'
    ? 'its random numbers are not seeded (KEPLOY_SEED_RANDOM=off, or keploySeedRandom: false), and the clock\'s start travels in the seed'
    : why === 'no seed'
      ? 'keploy answered its begin with no seed, and the clock\'s start travels in the seed'
      : 'the seed keploy answered carries no clock start (its recording was made with the clock not held)';
  return `keploy: the clock of ${name} in the test process is not held, though asked: ${because}; so the test reads keploy's run clock, ` +
    'and a value it stamps with the time may differ from its recording\'s' + (why === 'no start' ? ': record the test again with the clock held.' : '.');
}

/** The line a test shows when its recording held its clock and this run does not. */
export function heldBeforeLine(name: string): string {
  return `keploy: the recording of ${name} held its clock in the test process (its seed carries a start), but this run does not hold it, ` +
    'so a value the test stamps with the time may differ from its recording\'s: ' +
    `hold it here too (${ENV_HOLD_CLOCK}=on, or use: { ${OPTION_HOLD_CLOCK}: true }), or record the test again.`;
}

// Code whose clock reads are the worker's, not the test's: Playwright's and
// this package's.
const OWN = path.dirname(__filename);
const WORKER_CODE = ['playwright', 'playwright-core', '@playwright'].map((p) => `${path.sep}node_modules${path.sep}${p}${path.sep}`);

/**
 * Whether the nearest caller of below, a clock function, is the test's code:
 * the first frame of the stack that names a file (a native frame or an
 * eval's does not) is neither Node's own, nor Playwright's, nor this
 * package's. The stack is read raw, with no formatter: Playwright's (source
 * maps) is not run, and nothing it draws or reads is the test's.
 */
function testCalls(below: Function): boolean {
  const E = Error as { prepareStackTrace?: unknown; stackTraceLimit?: number };
  const was = Object.getOwnPropertyDescriptor(E, 'prepareStackTrace');
  const limit = E.stackTraceLimit;
  let frames: unknown = [];
  try {
    Object.defineProperty(E, 'prepareStackTrace', { value: (_e: unknown, f: unknown[]) => f, writable: true, enumerable: false, configurable: true });
    E.stackTraceLimit = 16;
    const o: { stack?: unknown } = {};
    Error.captureStackTrace(o, below);
    frames = o.stack;
  } finally {
    E.stackTraceLimit = limit;
    if (was === undefined) delete E.prepareStackTrace;
    else Object.defineProperty(E, 'prepareStackTrace', was);
  }
  if (!Array.isArray(frames)) return false;
  for (const f of frames as { getFileName?: () => string | null | undefined }[]) {
    let file = typeof f?.getFileName === 'function' ? f.getFileName() ?? '' : '';
    // A native frame or an eval's names no file: its caller is the reader.
    if (file === '') continue;
    // Node's own code (fetch, http, timers) reads the clock for itself.
    if (file.startsWith('node:')) return false;
    if (file.startsWith('file://')) {
      try { file = fileURLToPath(file); } catch { continue; }
    }
    if (!path.isAbsolute(file)) continue;
    if (path.dirname(file) === OWN) return false;
    for (const w of WORKER_CODE) if (file.includes(w)) return false;
    return true;
  }
  return false;
}

/**
 * Puts a Date in globalThis.Date's place whose reads by the test's code
 * (Date.now(), new Date() with no argument, Date() called) read the held
 * clock: start, then one millisecond later at each read. A read while a
 * worker fixture is set up (setAside's hold, under the random seat in place)
 * is the worker's and reads the real clock. Every other use is the real
 * Date's, and the held one is a Date like it (instanceof, its prototype,
 * Date.UTC, Date.parse). Returns what puts the real one back, which it does
 * only while globalThis.Date is still the held one: a test that put its own
 * there keeps it.
 */
export function seatClock(start: number): () => void {
  const Real = globalThis.Date;
  const aside = asideSet();
  let reads = 0;
  const test = (below: Function): boolean => aside.size === 0 && testCalls(below);
  const next = (): number => start + reads++;
  const realNow = Real.now;
  const now = { now(): number { return test(now) ? next() : realNow.call(Real); } }.now;
  const handler: ProxyHandler<DateConstructor> = {
    construct(target, args, newTarget) {
      const to = newTarget === held ? target : newTarget;
      if (args.length === 0 && test(handler.construct as Function)) return Reflect.construct(target, [next()], to);
      return Reflect.construct(target, args, to);
    },
    apply(target, self, args) {
      if (test(handler.apply as Function)) return new target(next()).toString();
      return Reflect.apply(target, self, args);
    },
    get(target, key) {
      if (key === 'now') return now;
      return Reflect.get(target, key, target);
    },
  };
  const held: DateConstructor = new Proxy(Real, handler);
  globalThis.Date = held;
  return () => {
    if (globalThis.Date === held) globalThis.Date = Real;
  };
}
