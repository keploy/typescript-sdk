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
//     a test keploy set aside is skipped with keploy's reason, which the
//     test's output shows;
//   - a test Playwright runs again in the run (a retry, a --repeat-each
//     repeat) fails without beginning, and keploy is told (POST
//     /agent/refusal), since keploy runs each test once in a run;
//   - before the test's browser context closes, the test waits until none of
//     its pages' calls is in flight (settle), so its calls end inside it;
//   - the test ends (POST /agent/scope/end) after its last teardown, with
//     its outcome; when keploy saw a call with no recorded answer, or a
//     recorded call the test no longer made, the test fails with keploy's
//     text;
//   - given(name, value) tells keploy a value the test made itself (a
//     session token it signs, a name it stamps with the time), which keploy
//     follows where the test's calls carry it.
// Any answer of the agent this package cannot trust fails the test.

import { test as base, expect } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_FAIL, ACTION_SKIP, AgentClient, KeployError } from './agent';
import type { Outcome, TestRef } from './agent';
import { ENV_TEST_PID, decide } from './join';
import type { Joining } from './join';
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
    const b = await c.begin(ref);
    if (b.action === ACTION_SKIP) {
      // The framework's own skip, with keploy's reason; no end follows.
      // Playwright's list, line and dot reporters print a test's output but
      // not its skip's reason, so the reason is printed as well.
      const why = keployText(b.reason, 'keploy: set aside (the agent gave no reason)');
      process.stderr.write(`${why} (keploy skipped ${ref.name})\n`);
      testInfo.skip(true, why);
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
