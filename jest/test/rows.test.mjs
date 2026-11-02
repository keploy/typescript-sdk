// Rows: real Jest runs of test/fixtures against a fake keploy agent, which
// answers as each row says. The agent and the fixtures write one journal, in
// the order things happened (each call of the agent is answered before Jest
// goes on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JEST = path.join(PKG, 'node_modules', 'jest', 'bin', 'jest.js');
const FIX = fs.realpathSync(path.join(PKG, 'test', 'fixtures'));
const CONFIG = path.join(FIX, 'jest.config.cjs');

// A fake keploy agent. answer(call) returns {status, body} or undefined for
// the protocol's plain "ok".
async function fakeAgent(journal, answer = () => undefined) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const call = { path: req.url, body: body ? JSON.parse(body) : null };
      const b = call.body ?? {};
      fs.appendFileSync(journal, call.path === '/agent/instance'
        ? `claim ${b.key} ${b.dir}\n`
        : `${call.path.slice('/agent/scope/'.length)} ${b.project ? `${b.project}::` : ''}${b.file}::${b.name}${b.outcome ? ` ${b.outcome}` : ''}\n`);
      let a = answer(call);
      if (!a) a = { body: call.path === '/agent/instance' ? { v: 1, instance: 'run', timeFile: '' } : { v: 1, status: 'ok' } };
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

// Runs Jest in band on files (relative to the fixtures) and returns the
// journal, each test's status and failure text by full name, and stderr.
async function jest(files, { answer, env = {}, agent = true, args = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kj-rows-'));
  const journal = path.join(tmp, 'journal');
  fs.writeFileSync(journal, '');
  const fake = agent ? await fakeAgent(journal, answer) : null;
  try {
    const out = path.join(tmp, 'out.json');
    const childEnv = { ...process.env, KJ_JOURNAL: journal, KEPLOY_MOCK_PROJECT: FIX };
    delete childEnv.KEPLOY_MOCK_AGENT;
    delete childEnv.KEPLOY_TEST_PID;
    if (fake) childEnv.KEPLOY_MOCK_AGENT = fake.url;
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [JEST, '--config', CONFIG, '-i', '--ci', '--no-cache', '--json', '--outputFile', out,
      ...args, '--runTestsByPath', ...files.map((f) => path.join(FIX, f))], { env: childEnv, cwd: FIX });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    const code = await new Promise((r) => child.on('close', r));
    const res = JSON.parse(fs.readFileSync(out, 'utf8'));
    const tests = {};
    const suites = {};
    for (const f of res.testResults) {
      suites[path.relative(FIX, f.name)] = { status: f.status, message: f.message };
      for (const t of f.assertionResults) tests[t.fullName] = { status: t.status, failure: t.failureMessages.join('\n') };
    }
    return { journal: fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean), tests, suites, stderr, code, pid: child.pid };
  } finally {
    if (fake) await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const statuses = (r) => Object.fromEntries(Object.entries(r.tests).map(([k, v]) => [k, v.status]));

// The number of times re matches s.
const count = (s, re) => (s.match(new RegExp(re.source, 'g')) ?? []).length;

test('without keploy the environment is Node\'s: no call, every test as Jest runs it', async () => {
  const r = await jest(['basic.test.js'], { agent: false });
  assert.deepEqual(r.journal, [
    'beforeEach orders pays', 'body pays', 'afterEach orders pays',
    'beforeEach orders declines', 'body declines', 'afterEach orders declines',
    'body top',
  ]);
  assert.deepEqual(statuses(r), { 'orders pays': 'passed', 'orders declines': 'passed', 'orders skipped by jest': 'pending', 'orders later': 'todo', top: 'passed' });
});

test('one claim for the process; each test Jest runs begins before its beforeEach and ends after its afterEach, with its outcome', async () => {
  const r = await jest(['basic.test.js', 'second.test.js'], { env: { KJ_FAIL: '1' } });
  assert.deepEqual(r.journal, [
    `claim . ${FIX}`,
    'begin basic.test.js::orders › pays', 'beforeEach orders pays', 'body pays', 'afterEach orders pays', 'end basic.test.js::orders › pays passed',
    'begin basic.test.js::orders › declines', 'beforeEach orders declines', 'body declines', 'afterEach orders declines', 'end basic.test.js::orders › declines failed',
    'begin basic.test.js::top', 'body top', 'end basic.test.js::top passed',
    'begin second.test.js::second file', 'body second file', 'end second.test.js::second file passed',
  ]);
  assert.equal(statuses(r)['orders declines'], 'failed');
});

test('the claim\'s key and each test\'s project are the Jest project\'s displayName', async () => {
  const r = await jest(['second.test.js'], { env: { KJ_DISPLAY_NAME: 'api' } });
  assert.deepEqual(r.journal, [`claim api ${FIX}`, 'begin api::second.test.js::second file', 'body second file', 'end api::second.test.js::second file passed']);
});

test('a test keploy set aside is skipped by Jest before any hook, with keploy\'s reason printed, and never ends', async () => {
  const r = await jest(['basic.test.js'], {
    answer: (c) => (c.path === '/agent/scope/begin' && c.body.name === 'orders › pays'
      ? { body: { v: 1, status: 'ok', action: 'skip', reason: 'quarantined/failed_in_record: the provider answered 500' } } : undefined),
  });
  assert.deepEqual(r.journal, [
    `claim . ${FIX}`,
    'begin basic.test.js::orders › pays',
    'begin basic.test.js::orders › declines', 'beforeEach orders declines', 'body declines', 'afterEach orders declines', 'end basic.test.js::orders › declines passed',
    'begin basic.test.js::top', 'body top', 'end basic.test.js::top passed',
  ]);
  assert.equal(statuses(r)['orders pays'], 'pending');
  assert.match(r.stderr, /keploy: quarantined\/failed_in_record: the provider answered 500 \[skipped basic\.test\.js › orders › pays\]/);
});

test('a test keploy fails at its end fails with keploy\'s text', async () => {
  const r = await jest(['second.test.js'], {
    answer: (c) => (c.path === '/agent/scope/end' ? { body: { v: 1, status: 'ok', action: 'fail', reason: 'keploy: GET /charge was not recorded' } } : undefined),
  });
  assert.equal(r.tests['second file'].status, 'failed');
  assert.match(r.tests['second file'].failure, /keploy: GET \/charge was not recorded/);
  assert.notEqual(r.code, 0);
});

test('an answer of the agent the package cannot trust fails the test it belongs to; a failed begin runs no beforeEach and sends no end', async () => {
  let r = await jest(['basic.test.js'], {
    answer: (c) => (c.path === '/agent/scope/begin' && c.body.name === 'orders › pays' ? { status: 500, body: 'boom' } : undefined),
  });
  assert.equal(r.tests['orders pays'].status, 'failed');
  assert.match(r.tests['orders pays'].failure, /the keploy agent answered 500 Internal Server Error to \/agent\/scope\/begin: "boom"/);
  assert.ok(!r.journal.includes('beforeEach orders pays') && !r.journal.includes('body pays'), r.journal.join('\n'));
  assert.ok(!r.journal.some((l) => l.startsWith('end basic.test.js::orders › pays')), r.journal.join('\n'));
  assert.equal(r.tests['orders declines'].status, 'passed');
  r = await jest(['second.test.js'], { answer: (c) => (c.path === '/agent/scope/end' ? { body: { status: 'ok' } } : undefined) });
  assert.equal(r.tests['second file'].status, 'failed');
  assert.match(r.tests['second file'].failure, /names no scope protocol version/);
});

test('a claim the agent refuses fails every test file and begins nothing', async () => {
  const r = await jest(['basic.test.js', 'second.test.js'], { answer: (c) => (c.path === '/agent/instance' ? { status: 404, body: '404 page not found' } : undefined) });
  assert.deepEqual(r.journal, [`claim . ${FIX}`]);
  for (const f of ['basic.test.js', 'second.test.js']) {
    assert.equal(r.suites[f].status, 'failed');
    assert.match(r.suites[f].message, /answered 404 to POST \/agent\/instance, so this Jest process cannot claim keploy's run/);
  }
});

test('KEPLOY_MOCK_AGENT that is not an agent\'s URL fails every test file', async () => {
  const r = await jest(['second.test.js'], { agent: false, env: { KEPLOY_MOCK_AGENT: 'localhost:1' } });
  assert.equal(r.suites['second.test.js'].status, 'failed');
  assert.match(r.suites['second.test.js'].message, /is neither off nor the http URL of a keploy agent/);
});

test('tests Jest itself does not run (focus, -t) never begin', async () => {
  let r = await jest(['focus/only.test.js']);
  assert.deepEqual(r.journal, [
    `claim . ${FIX}`,
    'begin focus/only.test.js::focused', 'body focused', 'end focus/only.test.js::focused passed',
    'begin focus/only.test.js::focused group › inside', 'body inside', 'end focus/only.test.js::focused group › inside passed',
  ]);
  r = await jest(['basic.test.js'], { args: ['-t', 'orders declines'] });
  assert.deepEqual(r.journal, [
    `claim . ${FIX}`,
    'begin basic.test.js::orders › declines', 'beforeEach orders declines', 'body declines', 'afterEach orders declines', 'end basic.test.js::orders › declines passed',
  ]);
});

test('a title begun twice in one file (a repeated title, a jest.retryTimes retry) fails, and its second run never begins', async () => {
  let r = await jest(['refusals/repeat.test.js']);
  assert.deepEqual(r.journal, [`claim . ${FIX}`, 'begin refusals/repeat.test.js::same', 'body same 1', 'end refusals/repeat.test.js::same passed']);
  const results = JSON.stringify(r.tests);
  assert.match(results, /same in refusals\/repeat\.test\.js would begin a second time/);
  // The refusal is the test's one failure: Jest starting the refused test
  // adds no second one.
  assert.doesNotMatch(results, /did not begin/);
  r = await jest(['refusals/retry.test.js']);
  assert.deepEqual(r.journal, [`claim . ${FIX}`, 'begin refusals/retry.test.js::flaky', 'body flaky 1', 'end refusals/retry.test.js::flaky failed']);
  assert.equal(r.tests.flaky.status, 'failed');
  assert.match(r.tests.flaky.failure, /flaky in refusals\/retry\.test\.js would begin a second time.*jest\.retryTimes/);
});

test('a test.concurrent test fails before its body ever runs; the file\'s other tests run', async () => {
  const r = await jest(['refusals/concurrent.test.js']);
  assert.deepEqual(r.journal, [`claim . ${FIX}`, 'begin refusals/concurrent.test.js::serial', 'body serial', 'end refusals/concurrent.test.js::serial passed']);
  assert.equal(r.tests['at once'].status, 'failed');
  assert.match(r.tests['at once'].failure, /at once is a test\.concurrent test, and keploy judges one test at a time/);
  assert.equal(count(r.tests['at once'].failure, /at once is a test\.concurrent test/), 1, r.tests['at once'].failure);
  assert.equal(r.tests['group nested at once'].status, 'failed');
  assert.match(r.tests['group nested at once'].failure, /group › nested at once is a test\.concurrent test/);
  assert.doesNotMatch(JSON.stringify(r.tests), /did not begin/);
  assert.equal(r.tests.serial.status, 'passed');
});

test('a refused test stays refused on every retry of jest.retryTimes: each run fails with the reason, none runs unjudged', async () => {
  // Begun once, failed, then retried twice: both retries are refused, and
  // neither runs its body.
  let r = await jest(['refusals/retry-twice.test.js']);
  assert.deepEqual(r.journal, [`claim . ${FIX}`, 'begin refusals/retry-twice.test.js::flaky', 'body flaky 1', 'end refusals/retry-twice.test.js::flaky failed']);
  assert.equal(r.tests.flaky.status, 'failed');
  assert.match(r.tests.flaky.failure, /flaky in refusals\/retry-twice\.test\.js would begin a second time.*jest\.retryTimes/);
  // A begin the agent failed: the retry fails with the same reason, and runs
  // no beforeEach and no body. Its afterEach hooks still run on each try,
  // outside any test: no second begin and no end.
  r = await jest(['refusals/retry-unbegun.test.js'], { answer: (c) => (c.path === '/agent/scope/begin' ? { status: 500, body: 'boom' } : undefined) });
  assert.deepEqual(r.journal, [`claim . ${FIX}`, 'begin refusals/retry-unbegun.test.js::steady', 'afterEach steady', 'afterEach steady']);
  assert.equal(r.tests.steady.status, 'failed');
  assert.match(r.tests.steady.failure, /the keploy agent answered 500 Internal Server Error to \/agent\/scope\/begin: "boom"/);
  // A repeated title: the second test's retry is refused too.
  r = await jest(['refusals/repeat-retry.test.js']);
  assert.deepEqual(r.journal, [`claim . ${FIX}`, 'begin refusals/repeat-retry.test.js::same', 'body same 1', 'end refusals/repeat-retry.test.js::same passed']);
  assert.match(JSON.stringify(r.tests), /same in refusals\/repeat-retry\.test\.js would begin a second time/);
  // A test.concurrent test fails before it runs, so Jest does not retry it;
  // its refusal is its one failure.
  r = await jest(['refusals/concurrent-retry.test.js']);
  assert.deepEqual(r.journal, [`claim . ${FIX}`]);
  assert.equal(r.tests['at once'].status, 'failed');
  assert.equal(count(r.tests['at once'].failure, /at once is a test\.concurrent test/), 1, r.tests['at once'].failure);
});

test('a project whose testRunner is not jest-circus (jest-jasmine2) fails every test file, claims nothing and begins nothing', async () => {
  const r = await jest(['basic.test.js', 'second.test.js'], { args: ['--testRunner', 'jest-jasmine2'] });
  assert.deepEqual(r.journal, []);
  assert.deepEqual(r.tests, {});
  for (const f of ['basic.test.js', 'second.test.js']) {
    assert.equal(r.suites[f].status, 'failed');
    assert.match(r.suites[f].message, /keploy: this Jest project's testRunner is \S*jest-jasmine2\S*, and @keploy\/jest needs jest-circus, Jest's default test runner: .* Remove testRunner from the Jest config, or set it to jest-circus\/runner/);
  }
});

test('a process a test starts is named a member (KEPLOY_TEST_PID is the claimer), with the sandbox\'s environment or Node\'s default one', async () => {
  const r = await jest(['child/spawn.test.js']);
  assert.ok(r.journal.includes(`child marker ${r.pid}`), `${r.journal.join('\n')}\njest pid ${r.pid}`);
  assert.ok(r.journal.includes(`default child marker ${r.pid}`), `${r.journal.join('\n')}\njest pid ${r.pid}`);
});

test('the project folder is named by its real path: through a symlink to it, the claim and the file names are the same', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kj-link-'));
  const link = path.join(tmp, 'project');
  fs.symlinkSync(FIX, link);
  try {
    const r = await jest(['second.test.js'], { env: { KEPLOY_MOCK_PROJECT: link } });
    assert.deepEqual(r.journal, [`claim . ${FIX}`, 'begin second.test.js::second file', 'body second file', 'end second.test.js::second file passed']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a Jest that runs inside the process KEPLOY_TEST_PID names is a member: inert', async () => {
  const r = await jest(['second.test.js'], { env: { KEPLOY_TEST_PID: String(process.pid) } });
  assert.deepEqual(r.journal, ['body second file']);
});
