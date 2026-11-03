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
//     keploy's reason;
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
//     order; KEPLOY_SEED_RANDOM=off or the option keploySeedRandom: false
//     turns it off.
// Any answer of the agent this package cannot trust fails the test.

import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_FAIL, ACTION_SKIP, AgentClient, KeployError, RANDOM_OWN, RANDOM_SEEDED } from './agent';
import type { Outcome, Random, TestRef } from './agent';
import { ENV_TEST_PID, decide } from './join';
import type { Joining } from './join';
import { SEEDED_LINE, freshSeed, initScript, pageScript, seedingFromEnv, unplacedLine, unseededLine } from './random';
import { Inflight } from './settle';

export { expect, KeployError };
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
// Whether this worker has said that it seeds the test browser.
let saidSeeded = false;
// How many contexts this worker seeded: each one's report function has its
// own name.
let reports = 0;

/**
 * Names each page the test opens in context (context.newPage(), the page
 * fixture's among them) by its place in the order the test opened them, in
 * every document of the page, before newPage returns: two tabs of a test
 * draw their own numbers, the same ones at replay. A popup is placed by its
 * opener's document in the page itself (initScript). Returns what undoes it.
 */
function placePages(context: BrowserContext): () => void {
  const had = Object.prototype.hasOwnProperty.call(context, 'newPage');
  const newPage = context.newPage;
  let made = 0;
  context.newPage = async function placed(this: BrowserContext): Promise<Page> {
    // Its place is taken when the test asks for it, not when the page
    // comes: two pages asked for at once keep the order the test asked in.
    const id = `t${made++}`;
    const p = await newPage.call(context);
    await p.addInitScript({ content: pageScript(id) });
    return p;
  };
  return () => {
    if (had) context.newPage = newPage;
    else delete (context as { newPage?: unknown }).newPage;
  };
}

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
   * Seed the test browser's random numbers per test under keploy (default
   * true), so a replay's pages draw what the recording's drew. Set false,
   * for record and replay alike, to give a project, a file or a test the
   * browser's own random numbers; KEPLOY_SEED_RANDOM=off does so for the
   * whole run.
   */
  keploySeedRandom: boolean;
};

type WorkerFixtures = { keployWorker: void };
type TestFixtures = { keployTest: void } & KeployOptions;

export const test = base.extend<TestFixtures, WorkerFixtures>({
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
  context: async ({ context, keployTest }, use) => {
    void keployTest;
    const s = seeding;
    if (client === null || s === null || open === null) {
      await use(context);
      return;
    }
    const name = open.name;
    let restore = (): void => {};
    if (s.seed !== '') {
      // A document the seeding cannot place draws the browser's own numbers
      // and says so here, once for each address in the test.
      const report = `__keploy_random_unplaced_${++reports}`;
      const told = new Set<string>();
      await context.exposeBinding(report, (_source, at: unknown) => {
        // The page's own text: one line, of a sane length.
        const a = (typeof at === 'string' ? at : String(at)).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 512);
        if (told.has(a)) return;
        told.add(a);
        process.stdout.write(`${unplacedLine(name, a)}\n`);
      });
      // Before the test's first page: an init script runs in every frame's
      // document before its own scripts.
      await context.addInitScript({ content: initScript(s.seed, report) });
      restore = placePages(context);
      if (!saidSeeded) {
        saidSeeded = true;
        process.stdout.write(`${SEEDED_LINE}\n`);
      }
    } else if (s.asked) {
      process.stdout.write(`${unseededLine(name)}\n`);
    }
    const seeded = s.seed !== '';
    const opened = (): void => { if (seeded) s.seededPage = true; else s.ownPage = true; };
    if (context.pages().length > 0) opened();
    context.on('page', opened);
    const inflight = new Inflight(context);
    try {
      await use(context);
    } finally {
      restore();
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
    const asked = seedingOn && keploySeedRandom;
    const b = await c.begin(ref, asked ? RANDOM_SEEDED : RANDOM_OWN, asked ? freshSeed() : undefined);
    if (b.action === ACTION_SKIP) {
      // The framework's own skip, with keploy's reason; no end follows.
      testInfo.skip(true, keployText(b.reason, 'keploy: set aside (the agent gave no reason)'));
      return;
    }
    const s: PageSeeding = { asked, seed: asked ? b.seed ?? '' : '', seededPage: false, ownPage: false };
    open = ref;
    seeding = s;
    await use();
    open = null;
    seeding = null;
    const e = await c.end(ref, outcomeOf(testInfo), randomDone(s));
    if (e.action === ACTION_FAIL) throw new KeployError(keployText(e.reason, 'keploy: the keploy agent failed this test and gave no reason'));
  }, { auto: true }],
});

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
