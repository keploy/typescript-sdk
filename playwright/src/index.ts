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
//   - each test begins (POST /agent/scope/begin) before its beforeEach hooks;
//     a test keploy set aside is skipped with keploy's reason;
//   - before the test's browser context closes, the test waits until none of
//     its pages' calls is in flight (settle), so its calls end inside it;
//   - the test ends (POST /agent/scope/end) after its last teardown, with
//     its outcome; when keploy saw a call with no recorded answer, or a
//     recorded call the test no longer made, the test fails with keploy's
//     text;
//   - given(name, value) tells keploy a value the test made itself (a
//     session token it signs, a name it stamps with the time), which keploy
//     follows where the test's calls carry it; given in a test.beforeAll, it
//     is the worker's, and keploy gives it to each test the worker begins
//     after it, until the worker moves on to another test file.
// Any answer of the agent this package cannot trust fails the test.

import { test as base, expect } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_FAIL, ACTION_SKIP, AgentClient, KeployError } from './agent';
import type { Outcome, TestRef } from './agent';
import { ENV_TEST_PID, decide } from './join';
import type { Joining } from './join';
import { WorkerFiles } from './files';
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
// The test this worker has open, if any: a value given while none is, is
// the worker's, for the tests of its test file.
let open: TestRef | null = null;
// The test file this worker is in, and whether keploy holds values it gave
// outside its tests.
const files = new WorkerFiles();

// enterFile ends the values keploy holds for this worker's earlier test file
// before the worker works in file (files.ts), so no test of file carries
// them. An end keploy refuses throws, and the worker stays in its earlier
// file: the next test tries again.
async function enterFile(c: AgentClient, file: string | null): Promise<void> {
  if (files.mustEnd(file)) {
    await c.endGiven();
    files.ended();
  }
  files.entered(file);
}

// The test file of the hook that runs now (a test.beforeAll runs with its
// file's first test's info), or null where Playwright gives none.
function hookFile(): string | null {
  try {
    return base.info().file;
  } catch {
    return null;
  }
}

type WorkerFixtures = { keployWorker: void };
type TestFixtures = { keployTest: void };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  keployWorker: [async ({}, use, workerInfo) => {
    const j = joining();
    if (j.mode === 'refused') throw new KeployError(j.refusal);
    if (j.mode === 'active') {
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

  context: async ({ context }, use) => {
    if (client === null) {
      await use(context);
      return;
    }
    const inflight = new Inflight(context);
    await use(context);
    if (inflight.size > 0) {
      const calls = inflight.describe();
      const shown = calls.slice(0, 5).join(', ') + (calls.length > 5 ? `, and ${calls.length - 5} more` : '');
      await base.step(`keploy: wait for the test's ${calls.length} call(s) in flight before its browser context closes: ${shown}`, () => inflight.settled());
    }
  },

  keployTest: [async ({ keployWorker }, use, testInfo) => {
    void keployWorker;
    const c = client;
    if (c === null) {
      await use();
      return;
    }
    const ref = testRef(testInfo);
    await enterFile(c, testInfo.file);
    const b = await c.begin(ref);
    if (b.action === ACTION_SKIP) {
      // The framework's own skip, with keploy's reason; no end follows.
      testInfo.skip(true, keployText(b.reason, 'keploy: set aside (the agent gave no reason)'));
      return;
    }
    open = ref;
    await use();
    open = null;
    const e = await c.end(ref, outcomeOf(testInfo));
    if (e.action === ACTION_FAIL) throw new KeployError(keployText(e.reason, 'keploy: the keploy agent failed this test and gave no reason'));
  }, { auto: true }],
});

/**
 * given tells keploy a value the test made itself, as an incoming request's
 * value is for a server test: keploy follows it where the test's calls carry
 * it, so a replay that makes a new value is compared by that name, never by
 * guessing. Give a distinctive value (a name with a nonce, a signed token),
 * whole as the calls carry it. Returns value.
 *
 * Given in a test or its beforeEach and afterEach hooks, the value is that
 * test's. Given while none of the worker's tests is open (a test.beforeAll
 * of this package's test, which runs once the worker claimed keploy's run),
 * it is the worker's: keploy gives it to each test the worker begins after
 * it, so a name a test file's setup mints once is followed in each of its
 * tests. Once the worker moves on to another test file, this package ends
 * that file's values, so no test of a later file carries them. A process no worker of this package's test runs in (a test file's
 * top level, globalSetup) has no test or worker to give it to, and given
 * fails there, naming where to give it instead.
 * Without keploy it returns value and does nothing else.
 */
export async function given(name: string, value: string): Promise<string> {
  const j = joining();
  if (j.mode === 'inert') return value;
  if (j.mode === 'refused') throw new KeployError(j.refusal);
  const c = client;
  if (c === null) {
    throw new KeployError(`keploy: the value ${name} was given where no worker of @keploy/playwright's test has claimed keploy's run, ` +
      'so keploy has no test and no worker to give it to: give it in a test of @keploy/playwright\'s test, in its beforeEach or afterEach hooks, ' +
      'or in its test.beforeAll (never at a test file\'s top level, in globalSetup, or in a hook of @playwright/test\'s own test)');
  }
  const outside = open === null;
  const source = sourceOf(new Error().stack ?? '');
  // A value given outside the tests is its test file's: the values an
  // earlier file gave end first.
  if (outside) await enterFile(c, hookFile());
  try {
    await c.given(name, value, source);
  } catch (err) {
    if (outside && err instanceof KeployError && err.code === 'not_open') {
      // This worker claimed the run, so the refusal most likely comes from
      // an agent that holds no value given outside a test.
      throw new KeployError(`${err.message}; ${name} was given outside every test (a test.beforeAll) by a worker that claimed the run, ` +
        'which a keploy agent that holds no value given outside a test refuses: use a keploy whose agent gives such a value ' +
        'to each later test of its worker, or give it in each test or its beforeEach hook', err.status, err.code);
    }
    throw err;
  }
  if (outside) files.gave();
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
