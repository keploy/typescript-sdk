// @keploy/jest joins a Jest suite to keploy's Universal Mocker.
//
// keploy records the calls each test's code makes (keploy mock record) and
// replays them (keploy mock replay), so the suite runs with every dependency
// answered from the recording. keploy judges every recorded test and lists
// the ones it cannot replay, with a reason. This package is how a test tells
// keploy where it begins and ends, and how keploy skips a test it set aside
// or fails a test whose calls changed. It speaks the same scope protocol
// (v1) as go-sdk's keploytest and @keploy/playwright; it decides nothing
// itself.
//
// It is a Jest test environment (jest-circus, Jest 29 and later):
//
//   // jest.config.js
//   module.exports = { testEnvironment: '@keploy/jest' };  // Node's environment
//
// or, around another environment:
//
//   // keploy-jsdom.js
//   const { withKeploy } = require('@keploy/jest');
//   module.exports = withKeploy(require('jest-environment-jsdom').TestEnvironment);
//
// Without keploy (KEPLOY_MOCK_AGENT unset or "off") nothing changes. Under
// keploy, with one test process (npx jest -i; keploy's first release runs
// one test process at a time, and refuses a second):
//   - the process claims keploy's run before its first test file (POST
//     /agent/instance), under its project's displayName ("." without one),
//     with keploy's project folder (KEPLOY_MOCK_PROJECT), which its test
//     files are named from; the current folder only when keploy names none;
//   - each test Jest runs begins (POST /agent/scope/begin) before its
//     beforeEach hooks; a test keploy set aside is skipped by Jest itself,
//     before any hook, and keploy's reason is printed;
//   - the test ends (POST /agent/scope/end) after its last afterEach hook,
//     with its outcome; when keploy saw a call with no recorded answer, or a
//     recorded call the test no longer made, the test fails with keploy's
//     text.
// Any answer of the agent this package cannot trust fails the test it
// belongs to (or, for the claim, the test file). A test keploy cannot judge
// one at a time (test.concurrent, a title repeated in one file, a retry of
// jest.retryTimes) fails with the reason; none runs unjudged.

import fs from 'node:fs';
import path from 'node:path';
import { ACTION_FAIL, ACTION_SKIP, AgentClient, KeployError } from './agent';
import type { Outcome, TestRef } from './agent';
import { ENV_TEST_PID, decide } from './join';
import type { Joining } from './join';

export { KeployError };
export type { TestRef, Outcome };

/** The part of a jest-circus test or describe block this package reads. */
export interface CircusBlock {
  name: string;
  mode?: string;
  parent?: CircusBlock;
}

/** The part of a jest-circus test this package reads and writes. */
export interface CircusTest extends CircusBlock {
  type?: string;
  concurrent?: boolean;
  errors: unknown[];
}

interface CircusDescribe extends CircusBlock {
  children?: Array<CircusTest | CircusDescribe>;
}

/** The part of jest-circus's state this package reads. */
export interface CircusState {
  hasFocusedTests?: boolean;
  testNamePattern?: RegExp | null;
  rootDescribeBlock?: CircusDescribe;
}

interface CircusEvent {
  name: string;
  test?: CircusTest;
}

let joined: Joining | null = null;
function joining(): Joining {
  if (joined === null) joined = decide(process.env, process.pid);
  return joined;
}

// The claim of this process: one per process, shared by every test file Jest
// runs in it (Jest requires the environment outside the test's sandbox).
let claimed: Promise<{ client: AgentClient; dir: string }> | null = null;
function claim(j: Extract<Joining, { mode: 'active' }>, key: string): Promise<{ client: AgentClient; dir: string }> {
  if (claimed === null) {
    claimed = (async () => {
      const client = new AgentClient(j.url, j.token);
      const dir = realpath(j.project || process.cwd());
      await client.claim(key, dir);
      process.env[ENV_TEST_PID] = String(process.pid);
      return { client, dir };
    })();
  }
  return claimed;
}

/**
 * Whether Jest runs the test it is starting: jest-circus's own rule, read at
 * test_start, before Jest applies it. A test keploy began that Jest skips
 * anyway ends as skipped; a test Jest starts that was not begun fails.
 */
export function jestRuns(test: CircusTest, state: CircusState): boolean {
  if (test.mode === 'skip' || test.mode === 'todo') return false;
  for (let p = test.parent; p; p = p.parent) {
    if (p.mode === 'skip') return false;
  }
  if (state.hasFocusedTests && test.mode === undefined) return false;
  if (state.testNamePattern && !state.testNamePattern.test(titles(test).join(' '))) return false;
  return true;
}

/** A test's name on keploy's wire: [project::]file::describes › title. */
export function testRef(test: CircusBlock, testPath: string, dir: string, project: string): TestRef {
  const file = toSlash(path.relative(dir, realpath(testPath)));
  const name = titles(test).join(' › ');
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
export function outcomeOf(test: Pick<CircusTest, 'errors'>): Outcome {
  return test.errors.length > 0 ? 'failed' : 'passed';
}

// The titles from the test file's outermost describe to the test: jest-
// circus's root block (the one with no parent) has no title of the test's.
function titles(test: CircusBlock): string[] {
  const out: string[] = [];
  for (let b: CircusBlock | undefined = test; b && b.parent; b = b.parent) out.unshift(b.name);
  return out;
}

// One test file's state.
class FileScope {
  private client: AgentClient | null = null;
  private dir = '';
  // Tests begun and not yet ended.
  private readonly open = new Map<CircusTest, TestRef>();
  // Every test ID begun in this file: a second begin of one fails.
  private readonly begun = new Set<string>();
  // Tests this package failed before they ran: never begun.
  private readonly refused = new Set<CircusTest>();

  constructor(private readonly testPath: string, private readonly project: string) {}

  async setup(sandboxEnv: NodeJS.ProcessEnv | undefined): Promise<void> {
    const j = joining();
    if (j.mode === 'inert') return;
    if (j.mode === 'refused') throw new KeployError(j.refusal);
    const c = await claim(j, this.project || '.');
    this.client = c.client;
    this.dir = c.dir;
    // The sandbox's process.env is a copy made before the claim: a test
    // that starts a process with it names the claimer too.
    if (sandboxEnv) sandboxEnv[ENV_TEST_PID] = String(process.pid);
  }

  async handle(event: CircusEvent, state: CircusState): Promise<void> {
    const c = this.client;
    if (c === null) return;
    const t = event.test;
    switch (event.name) {
      case 'run_start':
        // Concurrent tests start before their test_start: refuse them now,
        // and keep Jest from starting them at once.
        for (const ct of concurrentTests(state.rootDescribeBlock)) {
          ct.concurrent = false;
          this.refuse(ct, new KeployError(`keploy: ${titles(ct).join(' › ')} is a test.concurrent test, and keploy judges one test at a time: ` +
            'declare it with test instead of test.concurrent'));
        }
        return;
      case 'test_start': {
        if (!t || this.refused.has(t) || !jestRuns(t, state)) return;
        const ref = testRef(t, this.testPath, this.dir, this.project);
        const id = `${ref.project ?? ''}::${ref.file}::${ref.name}`;
        if (this.begun.has(id)) {
          this.refuse(t, new KeployError(`keploy: ${ref.name} in ${ref.file} would begin a second time, and keploy names a test by its file and title: ` +
            'give each test of a file its own title, and run without jest.retryTimes'));
          return;
        }
        this.begun.add(id);
        let b;
        try {
          b = await c.begin(ref);
        } catch (err) {
          this.refuse(t, err);
          return;
        }
        if (b.action === ACTION_SKIP) {
          // Jest's own skip: it runs no hook of the test. Jest shows no skip
          // reason, so keploy's is printed.
          t.mode = 'skip';
          process.stderr.write(`${keployText(b.reason, 'keploy: set aside (the agent gave no reason)')} [skipped ${ref.file} › ${ref.name}]\n`);
          return;
        }
        this.open.set(t, ref);
        return;
      }
      case 'test_skip':
      case 'test_todo': {
        // Begun, then skipped by Jest: the test's true outcome. A skipped
        // test shows no error, so an answer this package cannot trust
        // fails the test file instead (thrown into jest-circus).
        const ref = t && this.open.get(t);
        if (!t || !ref) return;
        this.open.delete(t);
        await c.end(ref, 'skipped');
        return;
      }
      case 'test_started':
        if (t && !this.open.has(t) && !this.refused.has(t)) {
          this.refuse(t, new KeployError(`keploy: Jest runs ${titles(t).join(' › ')}, which @keploy/jest did not begin because Jest's rule said it would skip it: ` +
            'this Jest decides which tests run differently from the Jest @keploy/jest knows; use a Jest that @keploy/jest supports'));
        }
        return;
      case 'test_done': {
        const ref = t && this.open.get(t);
        if (!t || !ref) return;
        this.open.delete(t);
        let e;
        try {
          e = await c.end(ref, outcomeOf(t));
        } catch (err) {
          t.errors.push(err);
          return;
        }
        if (e.action === ACTION_FAIL) t.errors.push(new KeployError(keployText(e.reason, 'keploy: the keploy agent failed this test and gave no reason')));
        return;
      }
      default:
    }
  }

  private refuse(t: CircusTest, err: unknown): void {
    this.refused.add(t);
    t.errors.push(err);
  }
}

function concurrentTests(block: CircusDescribe | undefined): CircusTest[] {
  const out: CircusTest[] = [];
  for (const child of block?.children ?? []) {
    if ((child as CircusTest).type === 'test') {
      if ((child as CircusTest).concurrent) out.push(child as CircusTest);
    } else {
      out.push(...concurrentTests(child as CircusDescribe));
    }
  }
  return out;
}

/** The environment class shape withKeploy wraps. */
export interface EnvironmentLike {
  global: { process?: { env?: NodeJS.ProcessEnv } } & Record<string, unknown>;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  handleTestEvent?(event: unknown, state: unknown): unknown;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EnvironmentClass = new (...args: any[]) => EnvironmentLike;

/** Wraps a Jest test environment class so its tests join keploy's run. */
export function withKeploy<T extends EnvironmentClass>(Base: T): T {
  const baseHandles = typeof Base.prototype.handleTestEvent === 'function';
  return class KeployEnvironment extends Base {
    readonly keploy: FileScope;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
      // Jest 29 and later construct an environment with ({globalConfig,
      // projectConfig}, {console, docblockPragmas, testPath}).
      this.keploy = new FileScope(String(args[1]?.testPath ?? ''), displayNameOf(args[0]?.projectConfig));
    }

    async setup(): Promise<void> {
      await super.setup();
      await this.keploy.setup(this.global.process?.env);
    }

    async handleTestEvent(event: unknown, state: unknown): Promise<void> {
      if (baseHandles) await super.handleTestEvent!(event, state);
      await this.keploy.handle(event as CircusEvent, state as CircusState);
    }
  };
}

// Jest's project config holds the displayName as {name, color}, whichever
// form the config gave it in.
function displayNameOf(projectConfig: { displayName?: { name?: unknown } } | undefined): string {
  const name = projectConfig?.displayName?.name;
  return typeof name === 'string' ? name : '';
}

function nodeEnvironment(): EnvironmentClass {
  // jest-environment-node 29 and 30 export the class as TestEnvironment and
  // as default.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require('jest-environment-node');
  return (m.TestEnvironment ?? m.default ?? m) as EnvironmentClass;
}

/** Node's test environment, joined to keploy's run. */
export const TestEnvironment = withKeploy(nodeEnvironment());
export default TestEnvironment;

function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function toSlash(p: string): string {
  return p.split(path.sep).join('/');
}
