// @keploy/playwright joins a Playwright suite to keploy's Universal Mocker.
//
// keploy records the calls each test's browser and app server make (keploy
// mock record) and replays them (keploy mock replay), so the suite runs with
// every backend answered from the recording. keploy judges every recorded
// test and lists the ones it cannot replay, with a reason. This package is
// how a test tells keploy where it begins and ends, and how keploy skips a
// test it set aside or fails a test whose calls changed. It speaks the same
// scope protocol (v1) as go-sdk's keploytest; it decides nothing itself.
//
// Specs import test (and expect) from this package instead of
// @playwright/test:
//
//   import { test, expect } from '@keploy/playwright';
//
// Without keploy (KEPLOY_MOCK_AGENT unset or "off") nothing changes. Under
// keploy, with one worker (keploy's first release runs one test process at a
// time):
//   - each worker claims keploy's run before its first test (POST
//     /agent/instance), under its Playwright project's name, with keploy's
//     project folder (KEPLOY_MOCK_PROJECT), which its test files are named
//     from; the current folder only when keploy names none;
//   - each test begins (POST /agent/scope/begin) before its beforeEach hooks,
//     saying whether its browser's random numbers are to be seeded (random:
//     "seeded" or "own") and, when they are, with a seed drawn afresh; keploy
//     answers the seed to draw from; a test keploy set aside is skipped with
//     keploy's reason, which the test's output shows;
//   - a test Playwright runs again in the run (a retry, a --repeat-each
//     repeat) fails without beginning, and keploy is told (POST
//     /agent/refusal), since keploy runs each test once in a run;
//   - before the test's browser context closes, the test waits until none of
//     its pages' calls is in flight (settle), so its calls end inside it;
//   - the test ends (POST /agent/scope/end) after its last teardown, with
//     its outcome and what its context's pages drew their random numbers
//     from (random); when keploy saw a call with no recorded answer, or a
//     recorded call the test no longer made, the test fails with keploy's
//     text;
//   - given(name, value) tells keploy a value the test made itself (a
//     session token it signs, a name it stamps with the time), which keploy
//     follows where the test's calls carry it;
//   - each test's browser draws its random numbers (Math.random,
//     crypto.getRandomValues, crypto.randomUUID) from a stream seeded by the
//     seed keploy answered its begin with, which a record keeps with the
//     test's recording, so a replay's pages make the calls the recording's
//     made; each page draws its own, named by its place in the test's
//     order; the test process draws Math.random from that seed too, from
//     the test's begin to its end, and so do @faker-js/faker's prebuilt
//     instances and those the suite gives seedFaker, so data the test makes
//     there (a name stamped with Math.random()) is the recording's; KEPLOY_SEED_RANDOM=off
//     or the option keploySeedRandom: false turns it off, and the worker
//     says once what that costs.
// Any answer of the agent this package cannot trust fails the test.

import { test as base, expect } from '@playwright/test';
import type { Page, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestInfo, TestType } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_FAIL, ACTION_SKIP, AgentClient, KeployError, RANDOM_OWN, RANDOM_SEEDED } from './agent';
import type { Outcome, Random, TestRef } from './agent';
import { ENV_TEST_PID, decide } from './join';
import type { Joining } from './join';
import { OFF_LINE, SEEDED_LINE, besideOf, fakerLine, fakersOf, freshSeed, initScript, othersNow, pageAddress, placePages, processRandom, seatFaker, seatRandom, seedingFromEnv, setAside, unplacedLine, unseededLine, workerRoutes, type Fakers, type Unplaced } from './random';
import { Inflight, sharedWorkerLine, sharedWorkerScript } from './settle';

export { expect, KeployError };
export { seedFaker } from './random';
export type { TestRef, Outcome };

let joined: Joining | null = null;
function joining(): Joining {
  if (joined === null) joined = decide(process.env, process.pid);
  return joined;
}

// This worker's client once it claimed the run; null when inert.
let client: AgentClient | null = null;
// The project directory test files are named relative to.
let projectDir = '';
// The test this worker has open, if any.
let open: TestRef | null = null;
// Whether the environment leaves the test browser's seeding on.
let seedingOn = false;
// Whether this worker has said that it seeds each test's random numbers.
let saidSeeded = false;
// Whether this worker has said what a test with seeding off costs.
let saidOff = false;
// The reasons this worker has said it cannot seed faker, each said once.
const saidFaker = new Set<string>();
// How many contexts this worker seeded: each one's report function has its
// own name.
let reports = 0;
// How many contexts of a keploy test this worker opened: each one's Shared
// Worker report function has its own name.
let sharedReports = 0;

// How a test's browser draws its random numbers.
type PageSeeding = {
  // Whether its begin asked keploy for a seed (seeding on, not opted out).
  asked: boolean;
  // The seed keploy answered; '' for none.
  seed: string;
  // Whether a page opened in its context fixture's context, seeded
  // (seededPage) or not (ownPage).
  seededPage: boolean;
  ownPage: boolean;
};
// The open test's, while one is open.
let seeding: PageSeeding | null = null;

/**
 * What the test's end says its browser drew from: seeded when a page of its
 * context was seeded, own when a page of its context was not, or when it
 * asked for a seed and keploy answered none. Nothing for a test whose pages
 * did not come from the context fixture (an API-only test, a context it made
 * itself): keploy keeps what its begin said.
 */
function randomDone(s: PageSeeding): Random | undefined {
  if (s.seededPage) return RANDOM_SEEDED;
  if (s.ownPage || (s.asked && s.seed === '')) return RANDOM_OWN;
  return undefined;
}

/** @keploy/playwright's options, for a config's or a file's use. */
export type KeployOptions = {
  /**
   * Seed the test browser's random numbers and the test process's
   * Math.random per test under keploy (default true), so a replay draws
   * what the recording drew. Set false, for record and replay alike, to give
   * a project, a file or a test their own random numbers;
   * KEPLOY_SEED_RANDOM=off does so for the whole run.
   */
  keploySeedRandom: boolean;
};

type WorkerFixtures = { keployWorker: void };
type TestFixtures = { keployTest: void } & KeployOptions;

const keployTestType = base.extend<TestFixtures, WorkerFixtures>({
  keployWorker: [async ({}, use, workerInfo) => {
    const j = joining();
    if (j.mode === 'refused') throw new KeployError(j.refusal);
    if (j.mode === 'active') {
      const s = seedingFromEnv(process.env);
      if (s.mode === 'refused') throw new KeployError(s.refusal);
      seedingOn = s.mode === 'seeded';
      const c = new AgentClient(j.url, j.token);
      projectDir = realpath(j.project || process.cwd());
      // The claim's key names the slice of the recording this worker's
      // calls outside tests are answered from: one per Playwright project,
      // whose workers run its tests one after another. Its folder is the
      // one the tests are named from, keploy's project folder: keploy files
      // the tests under it, and a folder above the project (a runner
      // started from the repository's root) holds no test of the project.
      await c.claim(workerInfo.project.name || '.', projectDir);
      process.env[ENV_TEST_PID] = String(process.pid);
      client = c;
    }
    await use();
  }, { scope: 'worker', auto: true }],

  keploySeedRandom: [true, { option: true }],

  // After keployTest: its begin's answer holds the seed.
  context: async ({ context, keployTest, browserName }, use) => {
    void keployTest;
    const s = seeding;
    if (client === null || s === null || open === null) {
      await use(context);
      return;
    }
    const name = open.name;
    let restore = (): void => {};
    // The lines that wait for a parent's parser to end, each said at the
    // test's end if it has not.
    const waiting = new Set<() => void>();
    const inflight = new Inflight(context);
    if (s.seed !== '') {
      // A document the seeding cannot place draws the browser's own numbers
      // and says so here, once for each address and reason in the test.
      const report = `__keploy_random_unplaced_${++reports}`;
      const told = new Set<string>();
      let opened: (page: Page | null | undefined) => Promise<boolean> = async () => false;
      await context.exposeBinding(report, async (source, at: unknown, why: unknown, above: unknown) => {
        const a = pageAddress(at);
        const w: Unplaced = why === 'frame' || why === 'uncounted' || why === 'nostorage' || why === 'worker' || why === 'shared' ? why : (await opened(source.page)) ? 'own' : 'popup';
        // Once for each address and reason: two documents at one address
        // (about:blank) may have no place for two reasons.
        const k = `${w}\n${a}`;
        if (told.has(k)) return;
        told.add(k);
        if (w !== 'uncounted') {
          process.stdout.write(`${unplacedLine(name, a, w)}\n`);
          return;
        }
        // Its line says how many frames are beside its frame once their
        // parent's parser has ended, or at the test's end.
        const b = besideOf(source.frame, Number(above));
        let said = false;
        const say = (): void => {
          if (said) return;
          said = true;
          waiting.delete(say);
          process.stdout.write(`${unplacedLine(name, a, w, othersNow(b))}\n`);
        };
        waiting.add(say);
        if (b !== null) {
          try {
            await b[1].waitForLoadState('domcontentloaded', { timeout: 0 });
          } catch {
            // The parent, or its page, is gone.
          }
        }
        say();
      });
      // Before the test's first page: an init script runs in every frame's
      // document before its own scripts.
      // The value by which the page fixture's script marks a page's first
      // document; the page's own scripts do not know it.
      const mark = freshSeed();
      // The workers' scripts: Firefox's route does not reach a Shared
      // Worker's, so there it is not marked, and says so. A worker whose
      // script a route of the test's own answered says so too, once for each
      // address.
      await workerRoutes(context, {
        answered: (r) => inflight.answered(r),
        routed: (at) => {
          const a = pageAddress(at);
          const k = `routed\n${a}`;
          if (told.has(k)) return;
          told.add(k);
          process.stdout.write(`${unplacedLine(name, a, 'routed')}\n`);
        },
      });
      await context.addInitScript({ content: initScript(s.seed, report, mark, browserName !== 'firefox') });
      const placing = placePages(context, mark);
      restore = placing.restore;
      opened = placing.opened;
    }
    // Seeded or not: each Shared Worker a page starts is one settle does not
    // wait on, and the test says so once for each script address (origin
    // and path).
    const sharedReport = `__keploy_shared_worker_${++sharedReports}`;
    const sharedTold = new Set<string>();
    await context.exposeBinding(sharedReport, (source, url: unknown) => {
      const u = String(url);
      inflight.sharedWorker(source.frame, u);
      const at = pageAddress(u.split('?')[0]);
      if (sharedTold.has(at)) return;
      sharedTold.add(at);
      process.stdout.write(`${sharedWorkerLine(name, at)}\n`);
    });
    await context.addInitScript({ content: sharedWorkerScript(sharedReport) });
    const seeded = s.seed !== '';
    const opened = (): void => { if (seeded) s.seededPage = true; else s.ownPage = true; };
    if (context.pages().length > 0) opened();
    context.on('page', opened);
    try {
      await use(context);
    } finally {
      restore();
      for (const say of waiting) say();
    }
    if (inflight.size > 0) {
      const calls = inflight.describe();
      const shown = calls.slice(0, 5).join(', ') + (calls.length > 5 ? `, and ${calls.length - 5} more` : '');
      await base.step(`keploy: wait for the test's ${calls.length} call(s) in flight before its browser context closes: ${shown}`, () => inflight.settled());
    }
  },

  keployTest: [async ({ keployWorker, keploySeedRandom }, use, testInfo) => {
    void keployWorker;
    const c = client;
    if (c === null) {
      await use();
      return;
    }
    const ref = testRef(testInfo);
    const again = runAgain(ref, testInfo);
    if (again !== null) {
      // keploy runs each test once in a run: a second run of it is failed
      // before its begin, and keploy is told, so its verdict names the test.
      // The message names no attempt, so the agent keeps one refusal for a
      // test however often it is run again (each retry is a new worker).
      let told = '';
      try {
        await c.refuse(REFUSE_RUN_AGAIN, again.message, again.remedy);
      } catch (err) {
        told = `; keploy could not be told: ${err instanceof Error ? err.message : String(err)}`;
      }
      throw new KeployError(`keploy: ${again.message} (${again.remedy})${told}`);
    }
    const asked = seedingOn && keploySeedRandom;
    const b = await c.begin(ref, asked ? RANDOM_SEEDED : RANDOM_OWN, asked ? freshSeed() : undefined);
    if (b.action === ACTION_SKIP) {
      // The framework's own skip, with keploy's reason; no end follows.
      // Playwright's list, line and dot reporters print a test's output but
      // not its skip's reason, so the reason is printed as well.
      const why = keployText(b.reason, 'keploy: set aside (the agent gave no reason)');
      process.stderr.write(`${why} (keploy skipped ${ref.name})\n`);
      testInfo.skip(true, why);
      return;
    }
    const s: PageSeeding = { asked, seed: asked ? b.seed ?? '' : '', seededPage: false, ownPage: false };
    if (s.seed !== '') {
      if (!saidSeeded) {
        saidSeeded = true;
        process.stdout.write(`${SEEDED_LINE}\n`);
      }
    } else if (asked) {
      process.stdout.write(`${unseededLine(ref.name)}\n`);
    } else if (!saidOff) {
      saidOff = true;
      process.stdout.write(`${OFF_LINE}\n`);
    }
    open = ref;
    seeding = s;
    // faker's instances, found (and its module loaded, when the test file
    // has not loaded it) before the seat, so what faker draws as it loads is
    // the worker's own, not the test's.
    let fakers: Fakers = { found: [], problem: '' };
    if (s.seed !== '') {
      fakers = fakersOf(testInfo.file);
      if (fakers.problem !== '' && !saidFaker.has(fakers.problem)) {
        saidFaker.add(fakers.problem);
        process.stdout.write(`${fakerLine(fakers.problem)}\n`);
      }
    }
    // The test process draws Math.random, and faker's instances draw, from
    // the test's seed from here, its beforeEach hooks included, until its
    // afterEach hooks and fixtures end.
    const unseat = s.seed !== '' ? seatRandom(processRandom(s.seed)) : null;
    const unseatFaker = s.seed !== '' ? seatFaker(s.seed, fakers.found) : null;
    try {
      await use();
    } finally {
      unseatFaker?.();
      unseat?.();
    }
    open = null;
    seeding = null;
    const e = await c.end(ref, outcomeOf(testInfo), randomDone(s));
    if (e.action === ACTION_FAIL) throw new KeployError(keployText(e.reason, 'keploy: the keploy agent failed this test and gave no reason'));
  }, { auto: true }],
});

/**
 * The test type specs import. Its extend, and use, give each worker fixture
 * they register the worker's own Math.random while it is set up, until it
 * calls use(), and so do those of each test type extend makes from it. A
 * worker fixture is set up in the first test that asks for it (unless it is
 * auto), after that test's seeding began, so its draws would otherwise come
 * from that test's stream and shift the test's own: a test would draw other
 * numbers when replayed alone, or after keploy set an earlier test aside.
 *
 * Its type is written out so the declaration names @playwright/test, the
 * package a project installs: TypeScript 7 would otherwise name playwright,
 * the package @playwright/test re-exports, which a strict installer such as
 * pnpm does not let the project see.
 */
export const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & TestFixtures, PlaywrightWorkerArgs & PlaywrightWorkerOptions & WorkerFixtures> =
  onWorkerSide(keployTestType);

type Registering = (fixtures: Record<string, unknown>) => unknown;

function onWorkerSide<T extends object>(t: T): T {
  const o = t as unknown as { extend: Registering; use: Registering };
  const extend = o.extend;
  const use = o.use;
  o.extend = function extend_(fixtures: Record<string, unknown>): unknown {
    return onWorkerSide(asCaller(extend_, () => extend(workerSideAll(fixtures))) as object);
  };
  o.use = function use_(fixtures: Record<string, unknown>): unknown {
    return asCaller(use_, () => use(workerSideAll(fixtures)));
  };
  return t;
}

// fixtures with each fixture function, alone or first in a [function,
// options] pair, made workerSide; every other value, and a symbol's (a test
// type's, which Playwright refuses to extend with), as given.
function workerSideAll(fixtures: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(fixtures);
  const out: Record<string, unknown> = { ...fixtures };
  for (const [name, v] of entries) {
    if (typeof v === 'function') out[name] = workerSide(v);
    else if (Array.isArray(v) && typeof v[0] === 'function' && typeof v[1] === 'object') out[name] = [workerSide(v[0]), ...v.slice(1)];
  }
  return out;
}

/**
 * fn, a fixture function, that while it sets up a worker fixture (until it
 * calls use(), or fails before) draws the worker's own Math.random. A worker
 * fixture is told of its worker (WorkerInfo), a test fixture of its test
 * (TestInfo, with its testId): a test fixture is the test's and runs as it
 * is. Playwright reads a fixture's parameters from its source, so the
 * wrapper reads as fn's.
 */
function workerSide(fn: Function): Function {
  const w = { async fixture(this: unknown, args: unknown, use: (v: unknown) => Promise<void>, info: unknown): Promise<unknown> {
    if (typeof (info as { testId?: unknown } | null)?.testId === 'string') return await Reflect.apply(fn, this, [args, use, info]);
    const back = setAside();
    try {
      return await Reflect.apply(fn, this, [args, async (v: unknown) => { back(); await use(v); }, info]);
    } finally {
      back();
    }
  } }.fixture;
  Object.defineProperty(w, 'toString', { value: () => fn.toString(), enumerable: false, writable: true, configurable: true });
  return w;
}

/**
 * Runs f, a call of Playwright's own extend or use, as if made by the code
 * that called wrapper. Playwright takes the file and line it names a fixture
 * by, in its errors and reports, from its caller's frame: it sets a function
 * in Error.prepareStackTrace and reads the second frame of a stack it
 * captures, which here is wrapper's, in this package. While f runs, a
 * function set there gets that code's frame in wrapper's place.
 */
function asCaller<R>(wrapper: Function, f: () => R): R {
  const E = Error as { prepareStackTrace?: unknown; stackTraceLimit?: number };
  const was = Object.getOwnPropertyDescriptor(E, 'prepareStackTrace');
  const limit = E.stackTraceLimit;
  try {
    // The frame of the code that called wrapper, as V8 gives it (one frame,
    // whatever limit the suite set).
    Object.defineProperty(E, 'prepareStackTrace', { value: (_e: unknown, frames: unknown[]) => frames, writable: true, enumerable: false, configurable: true });
    E.stackTraceLimit = 1;
    const o: { stack?: unknown } = {};
    Error.captureStackTrace(o, wrapper);
    const caller = (o.stack as unknown[])[0];
    // Playwright sets its function, reads, and sets back the one it found;
    // each is called, if at all, only before this puts the property back.
    let now: unknown;
    Object.defineProperty(E, 'prepareStackTrace', {
      get: () => now,
      set: (v: unknown) => { now = (e: unknown, frames: unknown[]) => Reflect.apply(v as Function, E, [e, [frames[0], caller, ...frames.slice(2)]]); },
      enumerable: false,
      configurable: true,
    });
    return f();
  } finally {
    E.stackTraceLimit = limit;
    if (was === undefined) delete E.prepareStackTrace;
    else Object.defineProperty(E, 'prepareStackTrace', was);
  }
}

/**
 * given tells keploy a value the open test made itself, as an incoming
 * request's value is for a server test: keploy follows it where the test's
 * calls carry it, so a replay that makes a new value is compared by that
 * name, never by guessing. Give a distinctive value (a name with a nonce, a
 * signed token), whole as the calls carry it. Returns value.
 * Without keploy it returns value and does nothing else.
 */
export async function given(name: string, value: string): Promise<string> {
  const j = joining();
  if (j.mode === 'inert') return value;
  if (j.mode === 'refused') throw new KeployError(j.refusal);
  const c = client;
  if (c === null || open === null) {
    throw new KeployError(`keploy: the value ${name} was given while no test was open: call given inside a test of @keploy/playwright's test, ` +
      'or in its beforeEach or afterEach hooks');
  }
  await c.given(name, value, sourceOf(new Error().stack ?? ''));
  return value;
}

/** A test's name on keploy's wire: [project::]file::titles › joined. */
export function testRef(ti: Pick<TestInfo, 'file' | 'titlePath' | 'project'>, dir = projectDir): TestRef {
  const file = toSlash(path.relative(dir || process.cwd(), realpath(ti.file)));
  // titlePath starts with the file; the rest are the describe groups and
  // the test's own title.
  const name = ti.titlePath.slice(1).join(' › ');
  const project = ti.project.name;
  return project ? { name, file, project } : { name, file };
}

/**
 * keploy's reason as the test shows it: once prefixed with "keploy: " (a
 * judging reason from the agent already is; a skip reason, "<class>/<reason>:
 * <detail>", is not), or fallback when the agent gave none, as go-sdk's
 * keploytest shows it.
 */
export function keployText(reason: string | undefined, fallback: string): string {
  if (!reason) return fallback;
  return reason.startsWith('keploy: ') ? reason : `keploy: ${reason}`;
}

/** The code of the refusal of a test Playwright runs again in one run. */
export const REFUSE_RUN_AGAIN = 'test_run_again';

/**
 * Why this run of the test is refused, or null for its first run: keploy
 * charges a test's calls to its one window in a run (scope protocol v1,
 * section 4), so a Playwright retry, or a repeat of --repeat-each, is not
 * begun.
 */
export function runAgain(ref: TestRef, ti: Pick<TestInfo, 'retry' | 'repeatEachIndex'>): { message: string; remedy: string } | null {
  const id = `${ref.project ? `${ref.project}::` : ''}${ref.file}::${ref.name}`;
  if (ti.retry > 0) {
    return { message: `Playwright retried ${id}, and keploy runs each test once in a run`,
      remedy: 'run the suite with --retries=0, and with no retries in its config or its test.describe.configure' };
  }
  if (ti.repeatEachIndex > 0) {
    return { message: `Playwright ran ${id} again for --repeat-each, and keploy runs each test once in a run`,
      remedy: 'run the suite without --repeat-each, and with no repeatEach in its config' };
  }
  return null;
}

/** The test's own verdict, as keploy's end takes it. */
export function outcomeOf(ti: Pick<TestInfo, 'status' | 'expectedStatus'>): Outcome {
  if (ti.status === 'skipped') return 'skipped';
  return ti.status === ti.expectedStatus ? 'passed' : 'failed';
}

// The caller of given, as file:line relative to the project: the first
// frame of the stack outside this package.
const SOURCE_MAX = 1024;
export function sourceOf(stack: string, dir = projectDir): string {
  const own = path.dirname(__filename);
  for (const line of stack.split('\n').slice(1)) {
    const m = /\(?((?:file:\/\/)?[^\s()]+):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!m) continue;
    let file = m[1].startsWith('file://') ? new URL(m[1]).pathname : m[1];
    if (!path.isAbsolute(file) || path.dirname(file) === own || file.startsWith('node:')) continue;
    file = toSlash(path.relative(dir || process.cwd(), file));
    const s = `${file}:${m[2]}`;
    return s.length > SOURCE_MAX ? `${path.basename(file)}:${m[2]}` : s;
  }
  return '';
}

function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function toSlash(p: string): string {
  return p.split(path.sep).join('/');
}
