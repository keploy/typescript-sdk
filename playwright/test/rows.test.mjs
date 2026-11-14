// Rows: real Playwright runs of test/fixtures against a fake keploy agent,
// which records every call and answers as each row says. They need
// Chromium, and the seeding's engine rows Firefox and WebKit too
// (npx playwright install chromium firefox webkit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOADS_KEY, OFF_LINE, SEEDED_LINE, initScript, processRandom, unplacedLine, unseededLine, workerMark, workerScript } from '../dist/random.js';
import { sharedWorkerLine } from '../dist/settle.js';
import { BLANK_DRAWS, DRAWS, documentAt, workerAt } from './draws.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'node_modules', '@playwright', 'test', 'cli.js');
const CONFIG = path.join(PKG, 'test', 'fixtures', 'playwright.config.ts');

// What happened, in order, across the fake agent and the page server.
function journal() {
  const events = [];
  return { events, add: (e) => events.push(e) };
}

// A fake keploy agent. answer(call) returns {status, body} or undefined for
// the protocol's plain "ok", which answers a begin with the seed it sent, as
// a record does.
async function fakeAgent(j, answer = () => undefined) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const call = { path: req.url, auth: req.headers.authorization ?? '', body: body ? JSON.parse(body) : null };
      j.add({ agent: call });
      let a = answer(call);
      if (!a) {
        a = { body: call.path === '/agent/instance' ? { v: 1, instance: 'run', timeFile: '' }
          : call.path === '/agent/scope/given' ? { v: 1, status: 'ok', variable: `given:${call.body.name}` }
            : call.path === '/agent/scope/begin' && call.body.seed ? { v: 1, status: 'ok', seed: call.body.seed }
              : { v: 1, status: 'ok' } };
      }
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

// The settle rows' page server: /slow and the end of /slowdoc are answered
// only once /release is called. /seen is answered once /slow has arrived, so
// a spec that cancels its call waits for the call to reach the server first:
// the browser's request event comes before that, and a call cancelled before
// it reaches the server proves nothing.
async function pageServer(j) {
  let release = null;
  const released = new Promise((r) => { release = r; });
  let saw = null;
  const seen = new Promise((r) => { saw = r; });
  const srv = http.createServer((req, res) => {
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>page</body></html>'); return; }
    if (req.url === '/loads') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><img src="/slow"></body></html>'); return; }
    if (req.url === '/release') { release(); res.end('ok'); return; }
    if (req.url === '/seen') { void seen.then(() => res.end('ok')); return; }
    // A service worker that calls /slow as it installs.
    if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end("self.addEventListener('install', () => { void fetch('/slow'); });"); return; }
    // A Shared Worker that answers each page that connects.
    if (req.url === '/shared.js?v=1') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end("onconnect = (e) => { e.ports[0].postMessage('up'); };"); return; }
    if (req.url === '/nocontent') { res.writeHead(204); res.end(); return; }
    if (req.url === '/resetcontent') { res.writeHead(205); res.end(); return; }
    // A disposition's type is case-insensitive (RFC 6266): the browser downloads "Attachment" too.
    if (req.url === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'Attachment; filename="d.bin"' }); res.end('bytes'); return; }
    if (req.url === '/download-lower') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="e.bin"' }); res.end('bytes'); return; }
    if (req.url === '/slowdoc') {
      // A document whose last byte comes only once /release is called.
      j.add({ page: 'slowdoc sent' });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><body>loading');
      void released.then(() => res.end('</body></html>'));
      return;
    }
    if (req.url === '/slow') {
      j.add({ page: 'slow sent' });
      saw();
      res.on('close', () => { if (!res.writableFinished) j.add({ page: 'slow cut' }); });
      res.on('finish', () => j.add({ page: 'slow answered' }));
      void released.then(() => res.end('slow'));
      return;
    }
    // A keepalive call (navigator.sendBeacon, fetch with keepalive): a POST,
    // answered as /slow is.
    if (req.url === '/beacon' && req.method === 'POST') {
      req.resume();
      req.on('end', () => { j.add({ page: 'beacon sent' }); saw(); });
      res.on('close', () => { if (!res.writableFinished) j.add({ page: 'beacon cut' }); });
      res.on('finish', () => j.add({ page: 'beacon answered' }));
      void released.then(() => res.end('beacon'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

// Runs one Playwright run of the fixture specs, from the folder cwd;
// returns each test's result.
async function playwright(specs, env, cwd = PKG) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpw-'));
  const report = path.join(tmp, 'report.json');
  const stepsFile = path.join(tmp, 'steps.jsonl');
  const childEnv = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report, PW_OUTPUT_DIR: path.join(tmp, 'out'), MARKER_DIR: tmp, STEPS_FILE: stepsFile, ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const child = spawn(process.execPath, [CLI, 'test', '-c', CONFIG, ...specs], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  if (!fs.existsSync(report)) throw new Error(`playwright wrote no report (exit ${code}):\n${out}`);
  const steps = fs.existsSync(stepsFile) ? fs.readFileSync(stepsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const tests = {};
  const walk = (suite, titles) => {
    for (const s of suite.suites ?? []) walk(s, s.file && s.title === s.file ? titles : [...titles, s.title]);
    for (const spec of suite.specs ?? []) {
      // Each run of the test (--repeat-each lists one spec for each), its
      // last attempt.
      const runs = spec.tests.map((t) => {
        const r = t.results[t.results.length - 1] ?? {};
        return {
          status: r.status ?? 'none',
          error: (r.errors ?? []).map((e) => e.message ?? '').join('\n'),
          annotations: r.annotations ?? t.annotations ?? [],
          stderr: (r.stderr ?? []).map((e) => e.text ?? '').join(''),
          stdout: (r.stdout ?? []).map((x) => x.text ?? Buffer.from(x.buffer ?? '', 'base64').toString()).join(''),
          attempts: t.results.length,
        };
      });
      const key = [...titles, spec.title].join(' › ');
      if (tests[key]) tests[key].runs.push(...runs);
      else {
        const mine = steps.filter((x) => x.test === spec.title);
        const begun = mine.filter((x) => x.step !== undefined);
        // order: the test's steps begun and its stdout writes, as they came.
        const order = mine.map((x) => (x.step !== undefined ? { step: x.step } : { out: x.out }));
        tests[key] = { ...runs[0], runs, steps: begun.map((x) => x.step), at: Object.fromEntries(begun.map((x) => [x.step, x.at])), order };
      }
    }
  };
  for (const s of JSON.parse(fs.readFileSync(report, 'utf8')).suites) walk(s, []);
  return { tests, tmp, out };
}

const keployEnv = (url) => ({ KEPLOY_MOCK_AGENT: url, KEPLOY_MOCK_AGENT_TOKEN: 'tok', KEPLOY_MOCK_PROJECT: PKG, KEPLOY_TEST_PID: undefined });
const calls = (j) => j.events.filter((e) => e.agent).map((e) => e.agent);
// Every call's path and body, each begin's seed shown as FRESH once it is
// checked to be a fresh one: 128 bits of hex, no two begins the same.
const FRESH = '<a fresh seed>';
function wire(j) {
  const seeds = calls(j).filter((c) => c.path === '/agent/scope/begin' && c.body.seed !== undefined).map((c) => c.body.seed);
  for (const sd of seeds) assert.match(sd, /^[0-9a-f]{32}$/);
  assert.equal(new Set(seeds).size, seeds.length, seeds.join(' '));
  return calls(j).map((c) => [c.path, c.body && c.body.seed !== undefined ? { ...c.body, seed: FRESH } : c.body]);
}
const ref = (file, name) => ({ name, file: `test/fixtures/${file}`, project: 'p1' });

test('inert without keploy: no call, every test runs as written', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    for (const v of [undefined, 'off']) {
      const { tests, tmp } = await playwright(['basic.spec.ts'], { KEPLOY_MOCK_AGENT: v, KEPLOY_TEST_PID: undefined });
      assert.deepEqual(Object.fromEntries(Object.entries(tests).map(([k, t]) => [k, t.status])),
        { 'g › a': 'passed', 'g › b': 'failed', 'g › c': 'skipped', 'g › d': 'failed' });
      assert.ok(fs.existsSync(path.join(tmp, 'a')));
    }
    assert.deepEqual(calls(j), []);
  } finally { await a.close(); }
});

test('a worker claims the run, each test begins before its beforeEach and ends with its outcome', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const { tests, tmp } = await playwright(['basic.spec.ts'], keployEnv(a.url));
    assert.deepEqual(Object.fromEntries(Object.entries(tests).map(([k, t]) => [k, t.status])),
      { 'g › a': 'passed', 'g › b': 'failed', 'g › c': 'skipped', 'g › d': 'failed' });
    const r = (n) => ref('basic.spec.ts', `g › ${n}`);
    const given = { name: 'seed', value: 'seed-value-1', source: 'test/fixtures/basic.spec.ts:7' };
    const claim = { key: 'p1', dir: fs.realpathSync(PKG) };
    // b fails, so Playwright runs c and d in a new worker, which claims again.
    assert.deepEqual(wire(j), [
      ['/agent/instance', claim],
      ['/agent/scope/begin', { ...r('a'), canSkip: true, random: 'seeded', seed: FRESH }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('a'), outcome: 'passed' }],
      ['/agent/scope/begin', { ...r('b'), canSkip: true, random: 'seeded', seed: FRESH }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('b'), outcome: 'failed' }],
      ['/agent/instance', claim],
      ['/agent/scope/begin', { ...r('c'), canSkip: true, random: 'seeded', seed: FRESH }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('c'), outcome: 'skipped' }],
      ['/agent/scope/begin', { ...r('d'), canSkip: true, random: 'seeded', seed: FRESH }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('d'), outcome: 'passed' }],
    ]);
    assert.ok(calls(j).every((c) => c.auth === 'Bearer tok'));
    // KEPLOY_TEST_PID named the claiming worker (test a checks it).
    assert.ok(fs.existsSync(path.join(tmp, 'a')));
  } finally { await a.close(); }
});

test('keploy skips a set-aside test with its reason, fails a judged-red one, and a refused begin fails the test', async () => {
  const j = journal();
  const a = await fakeAgent(j, (c) => {
    if (c.path === '/agent/scope/begin' && c.body.name === 'set aside') return { body: { v: 1, status: 'ok', action: 'skip', reason: 'flaky/request_changed: the body changed' } };
    if (c.path === '/agent/scope/end' && c.body.name === 'judged red') return { body: { v: 1, status: 'ok', action: 'fail', reason: 'keploy: GET /company had no recorded answer' } };
    if (c.path === '/agent/scope/begin' && c.body.name === 'refused') return { status: 422, body: { error: 'one_test_at_a_time', message: 'refused began while x was open', remedy: 'run one at a time' } };
    return undefined;
  });
  try {
    const { tests, tmp } = await playwright(['agent-says.spec.ts'], keployEnv(a.url));
    assert.equal(tests['set aside'].status, 'skipped');
    assert.deepEqual(tests['set aside'].annotations.filter((x) => x.type === 'skip').map((x) => x.description), ['keploy: flaky/request_changed: the body changed']);
    // Playwright's terminal reporters show a test's output, not its skip's
    // reason: the reason is in the output.
    assert.equal(tests['set aside'].stderr, 'keploy: flaky/request_changed: the body changed (keploy skipped set aside)\n');
    assert.equal(tests['judged red'].stderr, '');
    assert.ok(!fs.existsSync(path.join(tmp, 'set-aside-ran')), 'the set-aside test ran');
    assert.equal(tests['judged red'].status, 'failed');
    // The agent's judging reason already starts with "keploy: "; the test shows it once (gap13 showed it twice).
    assert.match(tests['judged red'].error, /keploy: GET \/company had no recorded answer/);
    assert.doesNotMatch(tests['judged red'].error, /keploy: keploy:/);
    assert.equal(tests.refused.status, 'failed');
    assert.match(tests.refused.error, /keploy: refused began while x was open \(run one at a time\)/);
    assert.ok(!fs.existsSync(path.join(tmp, 'refused-ran')), 'the refused test ran');
    // No end for a skipped test, nor for one whose begin was refused.
    assert.deepEqual(calls(j).filter((c) => c.path === '/agent/scope/end').map((c) => c.body.name), ['judged red']);
  } finally { await a.close(); }
});

test('keploy\'s skip reason is in the output Playwright\'s list reporter prints', async () => {
  const j = journal();
  const a = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.name === 'set aside'
    ? { body: { v: 1, status: 'ok', action: 'skip', reason: 'flaky/request_changed: the body changed' } } : undefined));
  try {
    const { tests, out } = await playwright(['agent-says.spec.ts', '-g', 'set aside', '--reporter=list,json'], keployEnv(a.url));
    assert.equal(tests['set aside'].status, 'skipped', out);
    assert.match(out, /keploy: flaky\/request_changed: the body changed \(keploy skipped set aside\)/);
  } finally { await a.close(); }
});

// retry.spec.ts's test fails its first attempt, and its group retries it
// once whatever the command line says.
const retried = 'retried › fails its first attempt';
const retryRefusal = {
  code: 'test_run_again',
  message: `Playwright retried p1::test/fixtures/retry.spec.ts::${retried}, and keploy runs each test once in a run`,
  remedy: 'run the suite with --retries=0, and with no retries in its config or its test.describe.configure',
};

test('a test Playwright retries is not begun again: the retry fails, saying why, and keploy is told', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const { tests, tmp, out } = await playwright(['retry.spec.ts'], keployEnv(a.url));
    const t = tests[retried];
    assert.equal(t.attempts, 2, out);
    assert.equal(t.status, 'failed');
    assert.equal(t.error.split('\n')[0], `KeployError: keploy: ${retryRefusal.message} (${retryRefusal.remedy})`);
    // The retry's body did not run.
    assert.ok(fs.existsSync(path.join(tmp, 'attempt-0')));
    assert.ok(!fs.existsSync(path.join(tmp, 'attempt-1')), 'the retry ran');
    const r = ref('retry.spec.ts', retried);
    const claim = { key: 'p1', dir: fs.realpathSync(PKG) };
    assert.deepEqual(wire(j), [
      ['/agent/instance', claim],
      ['/agent/scope/begin', { ...r, canSkip: true, random: 'seeded', seed: FRESH }], ['/agent/scope/end', { ...r, outcome: 'failed' }],
      // The retry runs in a new worker, which claims the run again.
      ['/agent/instance', claim],
      ['/agent/refusal', retryRefusal],
    ]);
  } finally { await a.close(); }
});

test('a retry keploy could not be told of still fails, saying why and what the agent answered', async () => {
  const j = journal();
  const a = await fakeAgent(j, (c) => (c.path === '/agent/refusal' ? { status: 500, body: 'boom' } : undefined));
  try {
    const { tests, tmp, out } = await playwright(['retry.spec.ts'], keployEnv(a.url));
    const t = tests[retried];
    assert.equal(t.attempts, 2, out);
    assert.equal(t.status, 'failed');
    assert.equal(t.error.split('\n')[0], `KeployError: keploy: ${retryRefusal.message} (${retryRefusal.remedy}); keploy could not be told: ` +
      'keploy: the keploy agent answered 500 Internal Server Error to /agent/refusal: "\\"boom\\""');
    assert.ok(!fs.existsSync(path.join(tmp, 'attempt-1')), 'the retry ran');
    assert.equal(calls(j).filter((c) => c.path === '/agent/scope/begin').length, 1);
  } finally { await a.close(); }
});

test('without keploy a retried test is retried as written', async () => {
  const { tests, tmp, out } = await playwright(['retry.spec.ts'], { KEPLOY_MOCK_AGENT: undefined, KEPLOY_TEST_PID: undefined });
  assert.equal(tests[retried].attempts, 2, out);
  assert.equal(tests[retried].status, 'passed');
  assert.ok(fs.existsSync(path.join(tmp, 'attempt-1')));
});

test('a test --repeat-each runs again is not begun again: the repeat fails, saying why, and keploy is told', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const { tests, out } = await playwright(['agent-says.spec.ts', '-g', 'judged red', '--repeat-each=2'], keployEnv(a.url));
    assert.deepEqual(tests['judged red'].runs.map((t) => t.status), ['passed', 'failed'], out);
    const message = 'Playwright ran p1::test/fixtures/agent-says.spec.ts::judged red again for --repeat-each, and keploy runs each test once in a run';
    const remedy = 'run the suite without --repeat-each, and with no repeatEach in its config';
    assert.equal(tests['judged red'].runs[1].error.split('\n')[0], `KeployError: keploy: ${message} (${remedy})`);
    const r = ref('agent-says.spec.ts', 'judged red');
    const claim = { key: 'p1', dir: fs.realpathSync(PKG) };
    assert.deepEqual(wire(j), [
      ['/agent/instance', claim],
      ['/agent/scope/begin', { ...r, canSkip: true, random: 'seeded', seed: FRESH }], ['/agent/scope/end', { ...r, outcome: 'passed' }],
      // Playwright runs each repeat in a worker of its own.
      ['/agent/instance', claim],
      ['/agent/refusal', { code: 'test_run_again', message, remedy }],
    ]);
  } finally { await a.close(); }
});

test('a refused claim fails every test of the worker, and no test begins', async () => {
  const j = journal();
  const a = await fakeAgent(j, (c) => (c.path === '/agent/instance'
    ? { status: 422, body: { error: 'one_test_process_at_a_time', message: 'process 2 asked to run tests while process 1 still runs them', remedy: 'run one test process at a time' } }
    : undefined));
  try {
    const { tests } = await playwright(['agent-says.spec.ts'], keployEnv(a.url));
    for (const t of Object.values(tests)) {
      assert.equal(t.status, 'failed');
      assert.match(t.error, /keploy: process 2 asked to run tests while process 1 still runs them \(run one test process at a time\)/);
    }
    assert.ok(calls(j).every((c) => c.path === '/agent/instance'));
  } finally { await a.close(); }
});

test('a malformed KEPLOY_MOCK_AGENT fails every test, naming it', async () => {
  const { tests } = await playwright(['agent-says.spec.ts'], { ...keployEnv('localhost:16789') });
  for (const t of Object.values(tests)) {
    assert.equal(t.status, 'failed');
    assert.match(t.error, /KEPLOY_MOCK_AGENT="localhost:16789" is neither off nor the http URL of a keploy agent/);
  }
});

test('a value given outside a test fails, and is not sent', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const { tests } = await playwright(['given-outside.spec.ts'], keployEnv(a.url));
    assert.equal(tests['after a given outside'].status, 'failed');
    assert.match(tests['after a given outside'].error, /the value early was given while no test was open/);
    assert.ok(!calls(j).some((c) => c.path === '/agent/scope/given'));
  } finally { await a.close(); }
});

test('settle: a call in flight when the body ends is answered before the test ends', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const p = await pageServer(j);
  try {
    const { tests, out } = await playwright(['settle.spec.ts', '-g', 'when the body ends'], { ...keployEnv(a.url), SLOW_BASE: p.url });
    assert.equal(tests['a call in flight when the body ends'].status, 'passed', out);
    const order = j.events.map((e) => (e.page ? e.page : e.agent.path));
    assert.deepEqual(order.filter((e) => e.startsWith('slow') || e === '/agent/scope/end'), ['slow sent', 'slow answered', '/agent/scope/end']);
  } finally { await p.close(); await a.close(); }
});

test('settle: a call that never ends fails the test by name, and is never cut before the end', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const p = await pageServer(j);
  try {
    const { tests, out } = await playwright(['settle.spec.ts', '-g', 'when the body ends'], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '4000' });
    const t = tests['a call in flight when the body ends'];
    assert.equal(t.status, 'timedOut', out);
    assert.ok(t.steps.some((s) => /^keploy: wait for the test's 1 call\(s\) in flight before its browser context closes: GET http:\/\/127\.0\.0\.1:\d+\/slow$/.test(s)), t.steps.join('\n'));
    // The test did not end while its call was open and uncut.
    const order = j.events.map((e) => (e.page ? e.page : e.agent.path));
    const end = order.indexOf('/agent/scope/end');
    assert.ok(end === -1 || order.slice(0, end).includes('slow cut'), `ended with the call open: ${order.join(', ')}`);
  } finally { await p.close(); await a.close(); }
});

test('settle: a call cancelled by its page loading another document is not waited for', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const p = await pageServer(j);
  try {
    const { tests, out } = await playwright(['settle.spec.ts', '-g', 'loading another document'], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '20000' });
    assert.equal(tests['a call its page cancelled by loading another document'].status, 'passed', out);
    const order = j.events.map((e) => (e.page ? e.page : e.agent.path));
    assert.deepEqual(order.filter((e) => e.startsWith('slow') || e === '/agent/scope/end'), ['slow sent', 'slow cut', '/agent/scope/end']);
  } finally { await p.close(); await a.close(); }
});

// Firefox can report the new document's first call before the frame's
// commit; the commit cancels only the old document's calls, so this one is
// still waited for, in every engine.
for (const engine of ['chromium', 'firefox', 'webkit']) {
  test(`settle, in ${engine}: a call the new document makes as it loads is waited for, whichever the browser reports first, the call or its frame's commit`, async () => {
    const j = journal();
    const a = await fakeAgent(j);
    const p = await pageServer(j);
    try {
      const title = 'a call its new document makes as it loads';
      const { tests, out } = await playwright(['settle.spec.ts', '-g', title], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '4000', PW_BROWSER: engine });
      const t = tests[title];
      assert.equal(t.status, 'timedOut', out);
      const named = /^keploy: wait for the test's 1 call\(s\) in flight before its browser context closes: GET http:\/\/127\.0\.0\.1:\d+\/slow$/;
      assert.ok(t.steps.some((s) => named.test(s)), t.steps.join('\n'));
    } finally { await p.close(); await a.close(); }
  });
}

// A Shared Worker's script: Chromium reports no end for it (Playwright does
// not follow Shared Workers), so settle never waits on it, in any engine,
// and the test says so, seeded or not.
for (const engine of ['chromium', 'firefox', 'webkit']) {
  test(`settle, in ${engine}: a test whose page starts a Shared Worker ends at once, its browser unseeded, and says once that the worker's script and calls are not waited for`, async () => {
    const j = journal();
    const a = await fakeAgent(j);
    const p = await pageServer(j);
    try {
      const title = 'a page that starts a Shared Worker';
      const { tests, out } = await playwright(['settle.spec.ts', '-g', title], { ...keployEnv(a.url), KEPLOY_SEED_RANDOM: 'off', SLOW_BASE: p.url, PW_TIMEOUT: '4000', PW_BROWSER: engine });
      const t = tests[title];
      assert.equal(t.status, 'passed', out);
      assert.ok(!t.steps.some((s) => s.startsWith('keploy: wait for')), t.steps.join('\n'));
      const said = t.stdout.split('\n').filter((l) => l.startsWith(`keploy: in ${title}, `)).map((l) => l.replace(/:\d+\//, ':<port>/'));
      assert.deepEqual(said, [sharedWorkerLine(title, 'http://127.0.0.1:<port>/shared.js')]);
    } finally { await p.close(); await a.close(); }
  });
}

test('settle: a route change inside the page cancels nothing, so its call in flight is waited for', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const p = await pageServer(j);
  try {
    const { tests, out } = await playwright(['settle.spec.ts', '-g', 'route change inside the page'], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '4000' });
    const t = tests['a call in flight across a route change inside the page'];
    assert.equal(t.status, 'timedOut', out);
    assert.ok(t.steps.some((s) => /^keploy: wait for the test's 1 call\(s\) in flight .*\/slow$/.test(s)), t.steps.join('\n'));
  } finally { await p.close(); await a.close(); }
});

test('settle: a navigation answered 204 replaces no document, so a call in flight is still waited for', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const p = await pageServer(j);
  try {
    const { tests, out } = await playwright(['settle.spec.ts', '-g', 'navigation answered 204'], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '4000' });
    const t = tests['a call in flight across a navigation answered 204'];
    assert.equal(t.status, 'timedOut', out);
    assert.ok(t.steps.some((s) => /^keploy: wait for the test's 1 call\(s\) in flight .*\/slow$/.test(s)), t.steps.join('\n'));
  } finally { await p.close(); await a.close(); }
});

test('an unnamed Playwright project claims with the key ".", and its tests name no project', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const { tests, out } = await playwright(['agent-says.spec.ts', '-g', 'judged red'], { ...keployEnv(a.url), PW_UNNAMED: '1' });
    assert.equal(tests['judged red'].status, 'passed', out);
    const r = { name: 'judged red', file: 'test/fixtures/agent-says.spec.ts' };
    assert.deepEqual(wire(j), [
      ['/agent/instance', { key: '.', dir: fs.realpathSync(PKG) }],
      ['/agent/scope/begin', { ...r, canSkip: true, random: 'seeded', seed: FRESH }],
      ['/agent/scope/end', { ...r, outcome: 'passed' }],
    ]);
  } finally { await a.close(); }
});

// A suite whose runner starts above its keploy project (mock.command
// "cd .. && npx playwright test", keploy.yml in tests/) names its test files
// from the project, so it claims with the project's folder too: keploy
// files the tests under the folder of the claim, and the folder above the
// project holds none of the project's tests.
test('a worker started above keploy\'s project claims with the project\'s folder, which its test files are named from', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const { tests, out } = await playwright(['agent-says.spec.ts', '-g', 'judged red'], keployEnv(a.url), path.dirname(PKG));
    assert.equal(tests['judged red'].status, 'passed', out);
    const r = ref('agent-says.spec.ts', 'judged red');
    assert.deepEqual(wire(j), [
      ['/agent/instance', { key: 'p1', dir: fs.realpathSync(PKG) }],
      ['/agent/scope/begin', { ...r, canSkip: true, random: 'seeded', seed: FRESH }],
      ['/agent/scope/end', { ...r, outcome: 'passed' }],
    ]);
  } finally { await a.close(); }
});

test('when keploy names no project, a worker claims with the current folder, which its test files are named from', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const cwd = path.dirname(PKG);
    const { tests, out } = await playwright(['agent-says.spec.ts', '-g', 'judged red'], { ...keployEnv(a.url), KEPLOY_MOCK_PROJECT: undefined }, cwd);
    assert.equal(tests['judged red'].status, 'passed', out);
    const r = { name: 'judged red', file: `${path.basename(PKG)}/test/fixtures/agent-says.spec.ts`, project: 'p1' };
    assert.deepEqual(wire(j), [
      ['/agent/instance', { key: 'p1', dir: fs.realpathSync(cwd) }],
      ['/agent/scope/begin', { ...r, canSkip: true, random: 'seeded', seed: FRESH }],
      ['/agent/scope/end', { ...r, outcome: 'passed' }],
    ]);
  } finally { await a.close(); }
});

// Settle rows where the browser cancelled a call: the test passes at once,
// with no wait step. Chromium ends a removed frame's calls itself; a closed
// page's it does not, and the package drops them, as it drops every call
// when the test closes its own context. A service worker's call has no
// frame, so only the context's close drops it: Chromium ends the worker
// with its context and reports no end for the call.
for (const [title, why] of [
  ['a call its removed cross-site frame had in flight', 'its cross-site frame is removed'],
  ['a call its closed page had in flight', 'its page closes'],
  ['a call in flight when the test closes its own context', 'the test closes its own context'],
  ['a service worker call in flight when the test closes its own context', 'the test closes its own context, which ends its service worker'],
]) {
  test(`settle: a call is not waited for once ${why}`, async () => {
    const j = journal();
    const a = await fakeAgent(j);
    const p = await pageServer(j);
    try {
      const { tests, out } = await playwright(['settle.spec.ts', '-g', title], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '20000' });
      const t = tests[title];
      assert.equal(t.status, 'passed', out);
      assert.deepEqual(t.steps.filter((s) => s.startsWith('keploy:')), []);
      assert.ok(j.events.some((e) => e.page === 'slow sent'));
    } finally { await p.close(); await a.close(); }
  });
}

// Settle rows where the page loads another document while one of its
// frames has a call in flight: the frame goes with the old document, and
// Playwright reports no end for its call, ordinary or keepalive
// (navigator.sendBeacon, fetch with keepalive, which the browser still
// sends: the page server sees it), nor for the frame's own document request
// when that document was still loading. The call is not waited for, so the
// test does not hang until its timeout.
for (const [title, why, call] of [
  ['a beacon its frame sends as the page loads another document', 'its frame sends it as the page loads another document', 'beacon'],
  ['a beacon its frame had in flight when the page loads another document', 'the page loads another document, though a beacon outlives its frame', 'beacon'],
  ['a keepalive fetch its frame had in flight when the page loads another document', 'the page loads another document, though a keepalive fetch outlives its frame', 'beacon'],
  ['a call its frame had in flight when the page loads another document', 'the page loads another document, with an ordinary call of its frame in flight', 'slow'],
  ['a document its frame was still loading when the page loads another document', 'the page loads another document while the frame\'s own document is still loading', 'slowdoc'],
]) {
  test(`settle: a frame's call is not waited for once ${why}`, async () => {
    const j = journal();
    const a = await fakeAgent(j);
    const p = await pageServer(j);
    try {
      const { tests, out } = await playwright(['settle.spec.ts', '-g', title], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '20000' });
      const t = tests[title];
      assert.equal(t.status, 'passed', out);
      assert.deepEqual(t.steps.filter((s) => s.startsWith('keploy:')), []);
      assert.ok(j.events.some((e) => e.page === `${call} sent`));
    } finally { await p.close(); await a.close(); }
  });
}

test('settle: a beacon from a page that stays is still waited for', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const p = await pageServer(j);
  try {
    const title = 'a beacon in flight from the page';
    const { tests, out } = await playwright(['settle.spec.ts', '-g', title], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '4000' });
    const t = tests[title];
    assert.equal(t.status, 'timedOut', out);
    const named = /^keploy: wait for the test's 1 call\(s\) in flight before its browser context closes: POST http:\/\/127\.0\.0\.1:\d+\/beacon$/;
    assert.ok(t.steps.some((s) => named.test(s)), t.steps.join('\n'));
  } finally { await p.close(); await a.close(); }
});

// Settle rows where nothing was cancelled: the call is still waited for, and
// the test times out naming it.
for (const [title, why, call] of [
  ['a call in flight across a navigation answered 205', 'a navigation answered 205 replaces no document', '/slow'],
  ['a call in flight across a download', 'a navigation answered with an attachment (a download, "Attachment") replaces no document', '/slow'],
  ['a call in flight across a lowercase attachment download', 'a navigation answered with an attachment (a download, "attachment") replaces no document', '/slow'],
  ['a document still loading after its frame commits', 'a navigation\'s own request stays in flight after its document commits', '/slowdoc'],
  ['a call in flight while another page of the test closes', 'another page closing cancels nothing of this page', '/slow'],
  ['a call in flight across a route change after an answered call', 'a route change after an answered call cancels nothing', '/slow'],
  ['a call its service worker has in flight', 'a service worker\'s call, which has no frame, is counted', '/slow'],
  ['a service worker call in flight while another page of the test closes', 'another page closing cancels nothing of a service worker', '/slow'],
]) {
  test(`settle: ${why}, so the call is still waited for`, async () => {
    const j = journal();
    const a = await fakeAgent(j);
    const p = await pageServer(j);
    try {
      const { tests, out } = await playwright(['settle.spec.ts', '-g', title], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '4000' });
      const t = tests[title];
      assert.equal(t.status, 'timedOut', out);
      const named = new RegExp(`^keploy: wait for the test's 1 call\\(s\\) in flight before its browser context closes: GET http://127\\.0\\.0\\.1:\\d+${call}$`);
      assert.ok(t.steps.some((s) => named.test(s)), t.steps.join('\n'));
    } finally { await p.close(); await a.close(); }
  });
}

// The seeding rows' page server: /draws draws random numbers in its first
// script, as it loads, and holds /frame from another host (localhost against
// 127.0.0.1: a cross-site frame), which draws the same way.
async function drawsServer() {
  const page = (body) => `<html><head><script>window.__draws = ${DRAWS};</script></head><body>${body}</body></html>`;
  // /held.js's answer waits for a load of /fh (or 10 s): each load lets one
  // /held.js through.
  const held = (() => {
    let loads = 0;
    const waiting = [];
    return {
      loaded: () => { const w = waiting.shift(); if (w) w(); else loads++; },
      script: (done) => {
        if (loads > 0) { loads--; done(); return; }
        const t = setTimeout(() => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); done(); }, 10000);
        t.unref();
        const go = () => { clearTimeout(t); done(); };
        waiting.push(go);
      },
    };
  })();
  const rheld = [];
  // Every URL the server was asked for, as the request named it.
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url, 'http://x');
    // /csp is served with a CSP sandbox: an opaque origin, no session storage.
    if (u.pathname === '/csp') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': 'sandbox allow-scripts' }); res.end(page('csp')); return; }
    if (u.pathname === '/held.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); held.script(() => res.end('')); return; }
    // parse.spec.ts's removed: /rhold.js is answered at /rrelease.
    if (u.pathname === '/rhold.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); rheld.push(res); return; }
    if (u.pathname === '/rrelease') { for (const r of rheld.splice(0)) r.end(''); res.end(''); return; }
    // workers.spec.ts's workers, and the scripts they load.
    const wk = {
      // Each Web Worker answers the message its page posts as it starts it.
      '/wk/ded.js': `importScripts('dep.js'); onmessage = (e) => postMessage({ kind: 'ded-early', data: e.data }); postMessage({ kind: 'ded', draws: ${DRAWS}, href: location.href, dep: self.dep, stack: String(new Error('at').stack) });`,
      '/wk/dep.js': 'self.dep = \'dep\';',
      '/wk/mod.js': `import { dep } from './lib.mjs'; self.onmessage = (e) => postMessage({ kind: 'mod-early', data: e.data }); postMessage({ kind: 'mod', draws: ${DRAWS}, href: location.href, dep, meta: import.meta.url, top: String(new Error('at').stack) });`,
      '/wk/lib.mjs': 'export const dep = \'lib\';',
      '/wk/shared.js': `onconnect = (e) => e.ports[0].postMessage({ kind: 'shared', draws: ${DRAWS}, href: location.href, stack: String(new Error('at').stack) });`,
      // Module Shared Workers: one plain, one (started by two names, c1
      // twice) served with a policy that refuses data: scripts. Each
      // connection after a worker's first is named by its number (c1+2).
      '/wk/mshared.js': `import { dep } from './lib.mjs'; const top = String(new Error('at').stack); self.onconnect = (e) => e.ports[0].postMessage({ kind: 'mshared', draws: ${DRAWS}, href: location.href, dep, meta: import.meta.url, top });`,
      '/wk/cshared.js': `import { dep } from './lib.mjs'; let n = 0; const draws = ${DRAWS}; const top = String(new Error('at').stack); self.onconnect = (e) => { n++; e.ports[0].postMessage({ kind: self.name + (n > 1 ? \`+\${n}\` : ''), draws, href: location.href, dep, meta: import.meta.url, top, stack: String(new Error('at').stack) }); };`,
    }[u.pathname];
    if (wk !== undefined) {
      res.writeHead(200, { 'content-type': 'text/javascript', ...(u.pathname === '/wk/cshared.js' ? { 'content-security-policy': 'script-src \'self\'' } : {}) });
      res.end(wk);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (u.pathname === '/wk') {
      const start = (s) => (s.startsWith('new Worker(') ? `{ const w = ${s}; w.onmessage = take; w.postMessage('early'); }` : `{ const s = ${s}; s.port.onmessage = take; s.port.start(); }`);
      res.end(page(`<script>window.__w = []; const take = (e) => window.__w.push(e.data);${WK_STARTS.map(start).join('')}</script>`));
      return;
    }
    if (u.pathname === '/draws') { res.end(page(`<iframe src="http://localhost:${srv.address().port}/frame"></iframe>`)); return; }
    if (u.pathname === '/frame') { res.end(page('frame')); return; }
    // /nest holds /frame of its own origin.
    if (u.pathname === '/nest') { res.end(page('<iframe src="/frame"></iframe>')); return; }
    // /long/... is a page at an address of any length.
    if (u.pathname.startsWith('/long/')) { res.end(page('')); return; }
    // places.spec.ts's: /host puts in a (/fa, its own origin), c (/fc) and
    // w (/fw, both cross-site) in the order ?order= names; /race holds r0
    // and r1 at /fr, and /fr answers late the one ?slow= names; /nested
    // holds x (/fa) and n (/fn), which holds y, z (/fb) and nn (/fa).
    const port = srv.address().port;
    if (u.pathname === '/host') {
      const src = { a: '/fa', c: `http://localhost:${port}/fc`, w: `http://localhost:${port}/fw` };
      const put = (u.searchParams.get('order') || '').split('').filter((n) => src[n])
        .map((n) => `{const f=document.createElement('iframe');f.name='${n}';f.src='${src[n]}';document.body.appendChild(f);}`).join('');
      res.end(page(`<script>${put}</script>`));
      return;
    }
    if (u.pathname === '/race') {
      const slow = u.searchParams.get('slow');
      res.end(page(`<iframe name="r0" src="/fr?n=0&slow=${slow}"></iframe><iframe name="r1" src="/fr?n=1&slow=${slow}"></iframe>`));
      return;
    }
    // /before puts in b0 (/fr, answered late), in a div when ?wrap=1, then
    // 50 ms later b1 (/fr, answered at once) before it; /set is a frameset
    // of f0 and f1 at /fa.
    if (u.pathname === '/before') {
      const wrap = u.searchParams.get('wrap') === '1';
      res.end(page(`<script>{const a=document.createElement('iframe');a.name='b0';a.src='/fr?n=0&slow=0';const at=${wrap ? "document.createElement('div')" : 'a'};if(at!==a)at.appendChild(a);document.body.appendChild(at);` +
        `setTimeout(()=>{const b=document.createElement('iframe');b.name='b1';b.src='/fr?n=1&slow=0';document.body.insertBefore(b,at);},50);}</script>`));
      return;
    }
    if (u.pathname === '/set') { res.end(`<html><head><script>window.__draws = ${DRAWS};</script></head><frameset cols="50%,50%"><frame name="f0" src="/fa"><frame name="f1" src="/fa"></frameset></html>`); return; }
    if (u.pathname === '/fr') { setTimeout(() => res.end(page('r')), u.searchParams.get('n') === u.searchParams.get('slow') ? 800 : 0); return; }
    if (u.pathname === '/nested') { res.end(page('<iframe name="x" src="/fa"></iframe><iframe name="n" src="/fn"></iframe>')); return; }
    if (u.pathname === '/fn') { res.end(page('<iframe name="y" src="/fb"></iframe><iframe name="z" src="/fb"></iframe><iframe name="nn" src="/fa"></iframe>')); return; }
    if (['/fa', '/fb', '/fc', '/fw', '/fm', '/fs'].includes(u.pathname)) { res.end(page(u.pathname)); return; }
    // /fsv, /fss and /fso replace the global parent before they draw.
    const swap = { '/fsv': 'var parent = 0;', '/fss': 'parent = self;', '/fso': 'window.parent = { length: 1 };' }[u.pathname];
    if (swap !== undefined) { res.end(`<html><head><script>${swap}</script><script>window.__draws = ${DRAWS};</script></head><body>${u.pathname}</body></html>`); return; }
    // many.spec.ts's: /many holds k frames m0.. at /fm, in its markup or put
    // in by one script (?how=); /sbx holds n sandboxed frames s0.. at /fs,
    // with nest=1 at /fsn (each holding a srcdoc frame c, of its origin),
    // or with swap=1, n at each of /fsv (v0..), /fss (s0..) and /fso (o0..);
    // /cost is a page of n elements, or of that many open shadow roots of
    // 10 elements each, beside an empty #box.
    if (u.pathname === '/many') {
      const k = Number(u.searchParams.get('k'));
      res.end(page(u.searchParams.get('how') === 'markup'
        ? Array.from({ length: k }, (_, i) => `<iframe name="m${i}" src="/fm"></iframe>`).join('')
        : `<script>for(let i=0;i<${k};i++){const f=document.createElement('iframe');f.name='m'+i;f.src='/fm';document.body.appendChild(f);}</script>`));
      return;
    }
    if (u.pathname === '/sbx') {
      const n = Number(u.searchParams.get('n'));
      const at = u.searchParams.get('swap') ? [['v', '/fsv'], ['s', '/fss'], ['o', '/fso']] : [['s', u.searchParams.get('nest') ? '/fsn' : '/fs']];
      res.end(page(at.flatMap(([k, path]) => Array.from({ length: n }, (_, i) => `<iframe name="${k}${i}" sandbox="allow-scripts" src="${path}"></iframe>`)).join('')));
      return;
    }
    if (u.pathname === '/fsn') { res.end(page(`<iframe name="c" srcdoc="<script>window.__draws = ${DRAWS};</script>"></iframe>`)); return; }
    // /full holds a (/ffill, cross-site), which fills its origin's session
    // storage in the tab and then has /full put in b (/ffx, cross-site too),
    // which holds y (/ffy, of b's origin). b cannot count its load, so it is
    // a frame under a parent of another origin with no session storage, and
    // y a frame inside one: a is beside b, y is alone in b.
    if (u.pathname === '/full') {
      res.end(page(`<iframe name="a" src="http://localhost:${port}/ffill"></iframe><script>addEventListener('message', (e) => { if (e.data !== 'full') return; ` +
        `const f = document.createElement('iframe'); f.name = 'b'; f.src = 'http://localhost:${port}/ffx'; document.body.appendChild(f); });</script>`));
      return;
    }
    if (u.pathname === '/ffill') {
      res.end(page(`<script>{ let s = 'x'.repeat(1 << 20), i = 0; while (s.length > 0) { try { sessionStorage.setItem('f' + i, s); i++; } catch (e) { s = s.slice(0, s.length >> 1); } } ` +
        `parent.postMessage('full', '*'); }</script>`));
      return;
    }
    if (u.pathname === '/ffx') { res.end(page('<iframe name="y" src="/ffy"></iframe>')); return; }
    if (u.pathname === '/ffy') { res.end(page('')); return; }
    // /held holds sandboxed frame h0 at /fh, then /held.js, then h1 and h2
    // at /fh. /held.js is answered only once h0 has loaded (its load sends
    // /fh-loaded), so its parent's parser puts h1 and h2 in only after h0
    // has drawn and loaded, every run.
    if (u.pathname === '/held') {
      const f = (n) => `<iframe name="${n}" sandbox="allow-scripts" src="/fh"></iframe>`;
      res.end(page(`${f('h0')}<script src="/held.js"></script>${f('h1')}${f('h2')}`));
      return;
    }
    if (u.pathname === '/fh') { res.end(page('<script>addEventListener("load", () => { new Image().src = "/fh-loaded"; });</script>')); return; }
    if (u.pathname === '/fh-loaded') { held.loaded(); res.end(''); return; }
    // parse.spec.ts's: two sandboxed frames u0, u1 at /fs, then a script
    // (/unparsed) or an image (/unloaded) the server never answers.
    if (u.pathname === '/unparsed' || u.pathname === '/unloaded') {
      const f = (n) => `<iframe name="${n}" sandbox="allow-scripts" src="/fs"></iframe>`;
      res.end(page(`${f('u0')}${f('u1')}${u.pathname === '/unparsed' ? '<script src="/hold.js"></script>' : '<img src="/hold.png">'}`));
      return;
    }
    if (u.pathname === '/hold.js' || u.pathname === '/hold.png') return;
    // parse.spec.ts's removed: frame p at /rparsed, which holds u0 and u1 at
    // /fs, then /rhold.js.
    if (u.pathname === '/removed') { res.end(page('<iframe name="p" src="/rparsed"></iframe>')); return; }
    if (u.pathname === '/rparsed') {
      const f = (n) => `<iframe name="${n}" sandbox="allow-scripts" src="/fs"></iframe>`;
      res.end(page(`${f('u0')}${f('u1')}<script src="/rhold.js"></script>`));
      return;
    }
    if (u.pathname === '/cost') {
      const n = Number(u.searchParams.get('n') || 0);
      const sh = Number(u.searchParams.get('shadow') || 0);
      res.end(page(`<div id="box"></div><script>{const f=document.createDocumentFragment();for(let i=0;i<${n};i++)f.appendChild(document.createElement('i'));` +
        `for(let i=0;i<${sh};i++){const h=document.createElement('div');f.appendChild(h);h.attachShadow({mode:'open'}).innerHTML='<span>a</span>'.repeat(10);}document.body.appendChild(f);}</script>`));
      return;
    }
    res.end('');
  });
  // Every address: the frame is asked for at localhost, which may be ::1.
  await new Promise((r) => srv.listen(0, r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

// One run of seeded.spec.ts (or another spec of the /draws page): what each
// test's pages drew, the run's tests, and what its begins and ends sent.
async function drawRun(j, env, specs = ['seeded.spec.ts'], names = ['one', 'two', 'again', 'three']) {
  const d = await drawsServer();
  const from = j.events.length;
  try {
    const { tests, tmp, out } = await playwright(specs, { ...env, DRAWS_BASE: d.url });
    for (const [k, t] of Object.entries(tests)) assert.equal(t.status, 'passed', `${k}: ${t.error}\n${out}`);
    const drew = {};
    for (const n of names) drew[n] = JSON.parse(fs.readFileSync(path.join(tmp, `${n}.json`), 'utf8'));
    const lines = Object.values(tests).map((t) => t.stdout).join('').split('\n');
    const said = lines.filter((l) => l === SEEDED_LINE).length;
    const sent = j.events.slice(from).filter((e) => e.agent).map((e) => e.agent);
    const begins = sent.filter((c) => c.path === '/agent/scope/begin').map((c) => c.body);
    const ends = sent.filter((c) => c.path === '/agent/scope/end').map((c) => [c.body.name, c.body.random]);
    // The seed each test's begin sent.
    const seeds = Object.fromEntries(begins.map((b) => [b.name.replace(/^own › /, ''), b.seed]));
    return { drew, said, lines, tests, tmp, begins, ends, seeds, seen: d.seen };
  } finally { await d.close(); }
}

// What a document at path draws first under seed, in the page the fixture
// named page (t0: the test's first).
const expected = (seed, path, storage, page = 't0') => documentAt(initScript(seed), path, storage, page).draws();
// A document's key: what a frame of its origin's page is named from, with
// the frame's place among its frames after it.
const keyOf = (seed, page, path, loads = 0) => `${seed}\n${page}\n${path}\n${loads}\n`;
const NAMES = ['one', 'two', 'again', 'own › three'];

test('seeded: a record seeds each test\'s pages from the fresh seed its begin sent, from their first script and in a cross-site frame; another test, or the record made again, draws others', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    const r1 = await drawRun(j, keployEnv(a.url));
    const r2 = await drawRun(j, keployEnv(a.url));
    for (const r of [r1, r2]) {
      // The numbers are the seed's: the init script ran before the page's
      // first script, in every frame.
      for (const n of ['one', 'two']) assert.deepEqual(r.drew[n], { top: expected(r.seeds[n], '/draws'), frame: expected(r.seeds[n], '/frame', undefined, 't0x') }, n);
      // A page loaded again draws new numbers; a query is no part of its name.
      const tab = new Map();
      const loads = [expected(r.seeds.again, '/draws', tab), expected(r.seeds.again, '/draws', tab), expected(r.seeds.again, '/draws', tab)];
      assert.deepEqual(r.drew.again.map((l) => l.top), loads);
      assert.notDeepEqual(loads[0], loads[1]);
      assert.notDeepEqual(r.drew.one, r.drew.two);
      // Each begin says how its test's browser means to draw; one that
      // seeds sends a fresh seed. The option's test sends none.
      assert.deepEqual(r.begins.map((b) => [b.name, b.random, typeof b.seed === 'string' && /^[0-9a-f]{32}$/.test(b.seed)]),
        [['one', 'seeded', true], ['two', 'seeded', true], ['again', 'seeded', true], ['own › three', 'own', false]]);
      // Each end says what its pages drew from.
      assert.deepEqual(r.ends, [['one', 'seeded'], ['two', 'seeded'], ['again', 'seeded'], ['own › three', 'own']]);
      // Said once a worker: one worker, one line; and no test went unseeded.
      assert.equal(r.said, 1);
      assert.equal(r.lines.filter((l) => l.includes('with no seed')).length, 0);
      // Called with a this that is no Crypto, the seeded functions throw
      // as the browser's own do.
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.tmp, 'this.json'), 'utf8')),
        { grv: 'TypeError: Illegal invocation', uuid: 'TypeError: Illegal invocation', drew: true });
    }
    // A record made again draws new numbers: a browser-made ID is not sent
    // twice to a real server.
    for (const n of ['one', 'two', 'again']) {
      assert.notEqual(r2.seeds[n], r1.seeds[n], n);
      assert.notDeepEqual(r2.drew[n], r1.drew[n], n);
    }
    // A test that turned it off with the option draws the browser's own.
    assert.notDeepEqual(r2.drew.three, r1.drew.three);
  } finally { await a.close(); }
});

test('seeded: a replay draws the numbers its recording drew, from the seed keploy answers, not the one its begin sent', async () => {
  const j = journal();
  const rec = await fakeAgent(j);
  let kept = {};
  // The replay's agent answers each begin with the seed its recording kept.
  const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
    ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
  try {
    const r = await drawRun(j, keployEnv(rec.url));
    kept = r.seeds;
    for (let i = 0; i < 2; i++) {
      const p = await drawRun(j, keployEnv(rep.url));
      for (const n of ['one', 'two', 'again']) {
        assert.deepEqual(p.drew[n], r.drew[n], n);
        assert.notEqual(p.seeds[n], kept[n], n);
      }
      assert.notDeepEqual(p.drew.three, r.drew.three);
      assert.deepEqual(p.ends, [['one', 'seeded'], ['two', 'seeded'], ['again', 'seeded'], ['own › three', 'own']]);
      assert.equal(p.said, 1);
    }
    // The draws follow the seed keploy answers, not the test's name: a test
    // whose entry was renamed (two, answered one's seed) draws as it did.
    kept = { ...r.seeds, two: r.seeds.one };
    const renamed = await drawRun(j, keployEnv(rep.url));
    assert.deepEqual(renamed.drew.two, r.drew.one);
  } finally { await rep.close(); await rec.close(); }
});

test('seeded: each page of a test draws its own numbers at one path, a popup placed by its opener too, the same ones at replay; a document keploy cannot place draws its own and is named', async () => {
  const j = journal();
  const rec = await fakeAgent(j);
  let kept = {};
  const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
    ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
  const names = ['tabs', 'atonce', 'nest', 'popnest', 'noopener'];
  // The unplaced lines a test printed, with the run's port as <port>.
  const unplaced = (r, n) => r.tests[n].stdout.split('\n').filter((l) => l.startsWith(`keploy: in ${n}, `)).map((l) => l.replace(/:\d+\//, ':<port>/'));
  try {
    const r = await drawRun(j, keployEnv(rec.url), ['tabs.spec.ts'], names);
    const seed = r.seeds.tabs;
    const t = r.drew.tabs;
    // Two tabs of the test at one path: each its own numbers, the tab's
    // place in the order the test opened them naming it, in its cross-site
    // frame too.
    assert.notEqual(t.second.top.uuid, t.first.top.uuid);
    assert.deepEqual(t.first, { top: expected(seed, '/draws'), frame: expected(seed, '/frame', undefined, 't0x') });
    assert.deepEqual(t.second, { top: expected(seed, '/draws', undefined, 't1'), frame: expected(seed, '/frame', undefined, 't1x') });
    // Two popups the first tab opened at one moment: each the window its
    // opener's document opened, in that order, from the opener's copied
    // session storage (its /draws loaded once).
    const opener = `${seed}\nt0\n/draws\n0\n`;
    for (const [w, i] of [['one', 0], ['two', 1]]) {
      assert.deepEqual(t[w].top, expected(seed, '/draws', new Map([[LOADS_KEY, '{"/draws":1}']]), `${opener}w${i}`), w);
    }
    const uuids = [t.first, t.second, t.one, t.two].map((d) => d.top.uuid);
    assert.equal(new Set(uuids).size, 4, uuids.join(' '));
    // A popup's cross-site frame has no place: the browser's own numbers,
    // named once for the test.
    assert.notDeepEqual(t.one.frame, t.two.frame);
    assert.deepEqual(unplaced(r, 'tabs'), [unplacedLine('tabs', 'http://localhost:<port>/frame')]);
    // Asked for at once, the pages keep the order the test asked in, not
    // the order they loaded in.
    const at = r.drew.atonce;
    assert.deepEqual(at.a.top, expected(r.seeds.atonce, '/draws'));
    assert.deepEqual(at.b.top, expected(r.seeds.atonce, '/draws', undefined, 't1'));
    assert.deepEqual(unplaced(r, 'atonce'), []);
    // A frame of the page's own origin, whose document may take over the
    // window of its first about:blank, is seeded in its parent document's
    // place, at the path its element asks for, the first there.
    assert.deepEqual(r.drew.nest, { top: expected(r.seeds.nest, '/nest'), frame: expected(r.seeds.nest, '/frame', undefined, `${keyOf(r.seeds.nest, 't0', '/nest')}f/frame\n0`) });
    assert.deepEqual(unplaced(r, 'nest'), []);
    // So is one in a popup, in the popup's place: the popup's document and
    // its frame both took over their windows' first about:blank.
    const pop = `${r.seeds.popnest}\nt0\n/draws\n0\nw0`;
    assert.deepEqual(r.drew.popnest, {
      top: expected(r.seeds.popnest, '/nest', new Map([[LOADS_KEY, '{"/draws":1}']]), pop),
      frame: expected(r.seeds.popnest, '/frame', undefined, `${keyOf(r.seeds.popnest, pop, '/nest')}f/frame\n0`),
    });
    assert.deepEqual(unplaced(r, 'popnest'), []);
    // A popup opened with noopener has no opener to place it: its own
    // numbers, never its opener's, and both its documents named.
    const n = r.drew.noopener;
    assert.deepEqual(n.first.top, expected(r.seeds.noopener, '/draws'));
    assert.notDeepEqual(n.popup.top, n.first.top);
    // (Sorted: the frame's renderer may tell first.)
    assert.deepEqual(unplaced(r, 'noopener').sort(), [unplacedLine('noopener', 'http://127.0.0.1:<port>/draws'), unplacedLine('noopener', 'http://localhost:<port>/frame')].sort());
    assert.deepEqual(r.ends, names.map((x) => [x, 'seeded']));
    // A replay answers the recording's seeds: each tab and popup draws what
    // it drew in the recording; what had no place draws anew, named again.
    kept = r.seeds;
    for (let i = 0; i < 2; i++) {
      const p = await drawRun(j, keployEnv(rep.url), ['tabs.spec.ts'], names);
      for (const w of ['first', 'second']) assert.deepEqual(p.drew.tabs[w], t[w], w);
      for (const w of ['one', 'two']) {
        assert.deepEqual(p.drew.tabs[w].top, t[w].top, w);
        assert.notDeepEqual(p.drew.tabs[w].frame, t[w].frame, w);
      }
      assert.deepEqual(p.drew.atonce, at);
      assert.deepEqual(p.drew.nest, r.drew.nest);
      assert.deepEqual(p.drew.popnest, r.drew.popnest);
      assert.deepEqual(p.drew.noopener.first, n.first);
      assert.notDeepEqual(p.drew.noopener.popup.top, n.popup.top);
      for (const x of names) assert.deepEqual(unplaced(p, x).sort(), unplaced(r, x).sort(), x);
      assert.deepEqual(p.ends, names.map((x) => [x, 'seeded']));
    }
  } finally { await rep.close(); await rec.close(); }
});

test('seeded: a page\'s first document, before its first goto and as setContent writes it, draws in the page\'s place, the same at replay; an address keploy cannot place is shown cut to 512 characters', async () => {
  const j = journal();
  const rec = await fakeAgent(j);
  let kept = {};
  const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
    ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
  const names = ['blank', 'longpath'];
  const unplaced = (r, n) => r.tests[n].stdout.split('\n').filter((l) => l.startsWith(`keploy: in ${n}, `));
  try {
    const r = await drawRun(j, keployEnv(rec.url), ['first.spec.ts'], names);
    // The page fixture's page and one context.newPage() made, each in its
    // place, in its one document: the page's draw before the first goto, then
    // its own script in what setContent wrote; the other's script in what
    // setContent wrote as soon as newPage returned, then a draw.
    const draws = (id) => {
      const d = documentAt(initScript(r.seeds.blank), 'blank', undefined, id);
      return [0, 1].map(() => JSON.parse(JSON.stringify(d.run(BLANK_DRAWS))));
    };
    const [first, set] = draws('t0');
    assert.deepEqual(r.drew.blank.page, { url: 'about:blank', first, set });
    const [oset, after] = draws('t1');
    assert.deepEqual(r.drew.blank.other, { url: 'about:blank', set: oset, after });
    assert.notDeepEqual(first, oset);
    assert.deepEqual(unplaced(r, 'blank'), []);
    // A noopener popup at an overlong address: named once, its address cut.
    const long = r.drew.longpath.url;
    assert.ok(long.length > 600, long);
    assert.deepEqual(unplaced(r, 'longpath'), [unplacedLine('longpath', long.slice(0, 512))]);
    assert.deepEqual(r.ends, names.map((x) => [x, 'seeded']));
    kept = r.seeds;
    const p = await drawRun(j, keployEnv(rep.url), ['first.spec.ts'], names);
    assert.deepEqual(p.drew.blank, r.drew.blank);
    assert.deepEqual(unplaced(p, 'blank'), []);
    assert.deepEqual(unplaced(p, 'longpath'), [unplacedLine('longpath', p.drew.longpath.url.slice(0, 512))]);
  } finally { await rep.close(); await rec.close(); }
});

// The engines the seeding's frame, first-document popup and own-init-script
// rows run in (CI installs all three).
const ENGINES = ['chromium', 'firefox', 'webkit'];

for (const engine of ENGINES) {
  test(`seeded, in ${engine}: frames of a first document each draw their own numbers, never their parent's, numbered at the path their element asks for, one put where a removed frame was, one in an open shadow root and one drawn from after its removal too; one in a closed shadow root has no place; a first document's popup is named in every engine; a top document with no session storage but the page's first draws its own and is named; the test's own context init script is named as the test's`, async () => {
    const j = journal();
    const rec = await fakeAgent(j);
    let kept = {};
    const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
      ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
    const names = ['frames', 'popupfromblank', 'ownctxinit', 'shadow', 'nostorage', 'removed'];
    const unplaced = (r, n) => r.tests[n].stdout.split('\n').filter((l) => l.startsWith(`keploy: in ${n}, `)).map((l) => l.replace(/:\d+\//, ':<port>/')).sort();
    const env = (url) => ({ ...keployEnv(url), PW_BROWSER: engine });
    try {
      const r = await drawRun(j, env(rec.url), ['engines.spec.ts'], names);
      const at = (id, where, seed = r.seeds.frames) => JSON.parse(JSON.stringify(documentAt(initScript(seed), where, new Map(), id).run(BLANK_DRAWS)));
      // The first document, its srcdoc frames, a frame inside one, its
      // about:blank frame, and the frame put in after that one's removal:
      // each its own numbers, a frame in its parent document's place at
      // the path its element asks for (about:srcdoc, about:blank), by how
      // many of the parent's frames asked for that path before it.
      const f = r.drew.frames;
      // Firefox runs a window's first document's init scripts before that
      // document has its URL, so its draws are its own engine's, not the vm
      // model's: there each document draws apart, the same at replay.
      const model = engine !== 'firefox';
      const top = keyOf(r.seeds.frames, 't0', 'blank');
      if (model) {
        assert.deepEqual(f.top, at('t0', 'blank'));
        assert.deepEqual(f.n, { url: 'about:srcdoc', draws: at(`${top}fabout:srcdoc\n0`, 'srcdoc') });
        assert.deepEqual(f.nn, { url: 'about:blank', draws: at(`${keyOf(r.seeds.frames, `${top}fabout:srcdoc\n0`, 'srcdoc')}fabout:blank\n0`, 'blank') });
        assert.deepEqual(f.s, { url: 'about:srcdoc', draws: at(`${top}fabout:srcdoc\n1`, 'srcdoc') });
        assert.deepEqual(f.b, { url: 'about:blank', draws: at(`${top}fabout:blank\n0`, 'blank') });
        assert.deepEqual(f.c, at(`${top}fabout:blank\n1`, 'blank'));
      }
      const docs = [f.top, f.n.draws, f.nn.draws, f.s.draws, f.b.draws, f.c].map((d) => JSON.stringify(d));
      assert.equal(new Set(docs).size, 6, docs.join('\n'));
      assert.deepEqual(unplaced(r, 'frames'), []);
      // A popup the first document opens with window.open('about:blank')
      // draws its own in every engine, and is named: Chromium places it,
      // but it has no session storage (its opener's origin is opaque);
      // Firefox and WebKit begin its document before window.open returns,
      // so it has no place there.
      const pop = r.drew.popupfromblank;
      assert.equal(pop.url, 'about:blank');
      assert.deepEqual(unplaced(r, 'popupfromblank'), [unplacedLine('popupfromblank', 'about:blank', engine === 'chromium' ? 'nostorage' : 'popup')]);
      // Top documents with no session storage: the page's first draws in
      // its place; about:blank loaded after it (twice), a srcdoc frame of
      // its origin in the first of those (its own reason, at its address), a page served with a CSP sandbox
      // (twice) and a data: URL (twice) each draw their own, named once for
      // each address, with why.
      const ns = r.drew.nostorage;
      if (model) assert.deepEqual(ns.first, at('t0', 'blank', r.seeds.nostorage));
      assert.ok(ns.csp.every((d) => d && typeof d.uuid === 'string'), JSON.stringify(ns.csp));
      const nsDocs = [ns.first, ...ns.blank, ns.inner, ...ns.csp, ...ns.data].map((d) => JSON.stringify(d));
      assert.equal(new Set(nsDocs).size, 8, nsDocs.join('\n'));
      assert.deepEqual(unplaced(r, 'nostorage'), ['about:blank', 'about:srcdoc', 'data:text/html,d', 'http://127.0.0.1:<port>/csp'].map((a) => unplacedLine('nostorage', a, 'nostorage')).sort());
      // The test's own context init script draws first in each document of
      // its page, its first about:blank too: named as the test's, with the
      // reason.
      // A popup that first document opens is at about:blank too, and has no
      // place since its opener has none: named again there, as a page the
      // app opened (a line for each address and reason).
      assert.deepEqual(unplaced(r, 'ownctxinit'), [...['about:blank', 'http://127.0.0.1:<port>/draws', 'http://localhost:<port>/frame'].map((a) => unplacedLine('ownctxinit', a, 'own')),
        unplacedLine('ownctxinit', 'about:blank', 'popup')].sort());
      // A frame in an open shadow root, which no engine lists among its
      // parent's frames, is placed by its element; one in a closed shadow
      // root, which its parent document cannot reach, has no place, and is
      // named with the frame reason.
      const sh = r.drew.shadow;
      assert.equal(sh.index, -1);
      if (model) assert.deepEqual(sh.open, at(`${keyOf(r.seeds.shadow, 't0', 'blank')}fabout:blank\n0`, 'blank', r.seeds.shadow));
      assert.notDeepEqual(sh.closed, sh.open);
      assert.deepEqual(unplaced(r, 'shadow'), [unplacedLine('shadow', 'about:blank', 'frame')]);
      // A removed frame's Math.random, first drawn from after the removal:
      // its document began (as the row took its functions) while the frame
      // was in the page, so it draws in that frame's place, never its
      // page's first document's numbers.
      assert.notDeepEqual(r.drew.removed, at('t0', 'blank', r.seeds.removed).random);
      if (model) assert.deepEqual(r.drew.removed, at(`${keyOf(r.seeds.removed, 't0', 'blank')}fabout:blank\n0`, 'blank', r.seeds.removed).random);
      assert.deepEqual(unplaced(r, 'removed'), []);
      assert.deepEqual(r.ends, names.map((x) => [x, 'seeded']));
      // A replay draws what each placed document drew; what had no place
      // draws anew, named again.
      kept = r.seeds;
      const p = await drawRun(j, env(rep.url), ['engines.spec.ts'], names);
      assert.deepEqual(p.drew.frames, f);
      assert.notDeepEqual(p.drew.popupfromblank.draws, pop.draws);
      assert.deepEqual(p.drew.nostorage.first, ns.first);
      assert.notDeepEqual(p.drew.nostorage.inner, ns.inner);
      for (const k of ['blank', 'csp', 'data']) for (const i of [0, 1]) assert.notDeepEqual(p.drew.nostorage[k][i], ns[k][i], `${k}${i}`);
      assert.notEqual(p.drew.ownctxinit.early, r.drew.ownctxinit.early);
      // A document that drew its own numbers before its page was named
      // keeps drawing its own: it is named once, as drawing them.
      assert.notEqual(p.drew.ownctxinit.late, r.drew.ownctxinit.late);
      assert.deepEqual({ ...p.drew.shadow, closed: null }, { ...sh, closed: null });
      assert.notDeepEqual(p.drew.shadow.closed, sh.closed);
      assert.deepEqual(p.drew.removed, r.drew.removed);
      for (const x of names) assert.deepEqual(unplaced(p, x), unplaced(r, x), x);
    } finally { await rep.close(); await rec.close(); }
  });

  test(`seeded, in ${engine}: a frame of its parent's origin keeps its place whatever order the frames come or load in: frames put in another order, two at one path whose documents load in the other order, a frame put back after its removal, a nested frame at another index than its parent, and one that loads another document; a cross-site frame is placed by its page and path`, async () => {
    const j = journal();
    const rec = await fakeAgent(j);
    let kept = {};
    const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
      ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
    const names = ['order', 'race', 'remount', 'nested', 'navigate', 'before', 'beforewrapped', 'frameset'];
    const lines = (r) => r.lines.filter((l) => l.startsWith('keploy: in '));
    const env = (url, order, slow) => ({ ...keployEnv(url), PW_BROWSER: engine, PLACES_ORDER: order, PLACES_SLOW: slow });
    try {
      // The record puts a, c, w in; the server answers r1 late.
      const r = await drawRun(j, env(rec.url, 'acw', '1'), ['places.spec.ts'], names);
      const seed = r.seeds;
      const ex = (n, path, page, loads = 0) => expected(seed[n], path, new Map([[LOADS_KEY, JSON.stringify({ [path]: loads })]]), page);
      // a in /host's place, the first frame there at /fa; c and w, under
      // a parent of another origin, by the page and their own paths.
      const host = (n) => keyOf(seed[n], 't0', '/host');
      assert.deepEqual(r.drew.order, {
        top: expected(seed.order, '/host'),
        a: ex('order', '/fa', `${host('order')}f/fa\n0`),
        c: ex('order', '/fc', 't0x'),
        w: ex('order', '/fw', 't0x'),
      });
      // r0 and r1 numbered in their elements' order, not their documents'.
      const race = keyOf(seed.race, 't0', '/race');
      // Put back, they take the next numbers there as they are put back,
      // whatever order their documents then load in.
      assert.deepEqual(r.drew.race, {
        r0: ex('race', '/fr', `${race}f/fr\n0`), r1: ex('race', '/fr', `${race}f/fr\n1`),
        again0: ex('race', '/fr', `${race}f/fr\n2`), again1: ex('race', '/fr', `${race}f/fr\n3`),
      });
      // The frame put back at /fa takes the next number there: its own
      // numbers, never the removed one's.
      assert.deepEqual(r.drew.remount, { first: ex('remount', '/fa', `${host('remount')}f/fa\n0`), again: ex('remount', '/fa', `${host('remount')}f/fa\n1`) });
      // nn, n's third frame (n is the top's second), in n's place: never
      // x's numbers, though both are the first at /fa in their parents.
      const nested = keyOf(seed.nested, 't0', '/nested');
      const n = `${nested}f/fn\n0`;
      const inN = keyOf(seed.nested, n, '/fn');
      assert.deepEqual(r.drew.nested, {
        x: ex('nested', '/fa', `${nested}f/fa\n0`),
        n: ex('nested', '/fn', n),
        y: ex('nested', '/fb', `${inN}f/fb\n0`),
        z: ex('nested', '/fb', `${inN}f/fb\n1`),
        nn: ex('nested', '/fa', `${inN}f/fa\n0`),
      });
      assert.notDeepEqual(r.drew.nested.nn, r.drew.nested.x);
      // A frame keeps its place in each document it loads: /fb, then /fa
      // a second time in that frame.
      const a = `${host('navigate')}f/fa\n0`;
      assert.deepEqual(r.drew.navigate, [ex('navigate', '/fa', a), ex('navigate', '/fb', a), ex('navigate', '/fa', a, 1)]);
      // b0 is numbered as it is put in, before its document loads: b1, put
      // in before it later, and whose document loads first, is the second
      // at /fr, wrapped or not.
      for (const x of ['before', 'beforewrapped']) {
        const k = keyOf(seed[x], 't0', '/before');
        assert.deepEqual(r.drew[x], { b0: ex(x, '/fr', `${k}f/fr\n0`), b1: ex(x, '/fr', `${k}f/fr\n1`) }, x);
      }
      // A frameset's frames are placed as an iframe is.
      const set = keyOf(seed.frameset, 't0', '/set');
      assert.deepEqual(r.drew.frameset, { f0: ex('frameset', '/fa', `${set}f/fa\n0`), f1: ex('frameset', '/fa', `${set}f/fa\n1`) });
      assert.deepEqual(lines(r), []);
      // Replays: w, a, c put in, and r0 answered late; then the record's
      // own order. Each frame draws what it drew in the record, and no
      // document is named.
      kept = r.seeds;
      for (const [order, slow] of [['wac', '0'], ['acw', '1']]) {
        const p = await drawRun(j, env(rep.url, order, slow), ['places.spec.ts'], names);
        for (const x of names) assert.deepEqual(p.drew[x], r.drew[x], `${order} ${x}`);
        assert.deepEqual(lines(p), [], order);
      }
    } finally { await rep.close(); await rec.close(); }
  });
}

for (const engine of ENGINES) {
  test(`seeded, in ${engine}: 300 frames in a page's markup, or put in by one script, each load and draw their own numbers, the same at replay, with no page error; sandboxed frames are never seeded, each draws its own numbers and is named with how many frames are beside it once its parent's parser has ended: three at one path, a lone one, a new one put in at a removed one's path, ones whose own script replaces the global parent before they draw, one that draws and loads while its parent's parser holds the frames after it, and a srcdoc frame inside one (sandboxed too, alone under its parent); a cross-site frame that cannot count its load (its origin's session storage full) and a frame of its origin inside it are named with the frames beside the first; a page whose DOM changes often is walked only when a frame is put in`, async () => {
    const j = journal();
    const rec = await fakeAgent(j);
    let kept = {};
    const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
      ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
    const names = ['markup', 'script', 'sandboxed', 'lone', 'swapped', 'held', 'nested', 'filled', 'cost'];
    const env = (url) => ({ ...keployEnv(url), PW_BROWSER: engine });
    const unplaced = (r, n) => r.tests[n].stdout.split('\n').filter((l) => l.startsWith(`keploy: in ${n}, `)).map((l) => l.replace(/:\d+\//, ':<port>/'));
    const line = (n, at, others) => unplacedLine(n, `http://127.0.0.1:<port>${at}`, 'uncounted', others);
    const SWAP = [['v', '/fsv'], ['s', '/fss'], ['o', '/fso']];
    const sandboxed = (run) => {
      assert.deepEqual(unplaced(run, 'sandboxed'), [line('sandboxed', '/fs', 2)]);
      assert.deepEqual(unplaced(run, 'lone'), [line('lone', '/fs', 0)]);
      assert.deepEqual(unplaced(run, 'swapped').sort(), SWAP.map(([, at]) => line('swapped', at, 8)).sort());
      assert.deepEqual(unplaced(run, 'held'), [line('held', '/fh', 2)]);
      // A srcdoc frame in a sandboxed one is sandboxed too, so its origin
      // is an opaque one of its own, not its parent's: it is itself a frame
      // under a parent of another origin with no session storage, alone
      // under its parent, and its line counts no other frame (every engine).
      assert.deepEqual(unplaced(run, 'nested').sort(), [line('nested', '/fsn', 1), unplacedLine('nested', 'about:srcdoc', 'uncounted', 0)].sort());
      // A cross-site frame b that cannot count its load (a frame of its
      // origin filled that origin's session storage in the tab), and y, of
      // b's origin, inside it: both lines count the frames beside b under
      // its parent (a), not those beside y in b (none).
      const full = (at) => unplacedLine('filled', `http://localhost:<port>${at}`, 'uncounted', 1);
      assert.deepEqual(unplaced(run, 'filled').sort(), [full('/ffx'), full('/ffy')].sort());
    };
    try {
      const r = await drawRun(j, env(rec.url), ['many.spec.ts'], names);
      const seed = r.seeds;
      // Every frame loads, each the k-th at /fm in /many, and nothing is
      // thrown into the page.
      for (const how of ['markup', 'script']) {
        const { drew, errors } = r.drew[how];
        assert.deepEqual(errors, [], how);
        assert.equal(drew.filter((x) => x !== null).length, 300, how);
        const k = keyOf(seed[how], 't0', '/many');
        drew.forEach((x, i) => assert.deepEqual(x, expected(seed[how], '/fm', new Map(), `${k}f/fm\n${i}`), `${how} m${i}`));
        assert.deepEqual(unplaced(r, how), [], how);
      }
      // Sandboxed frames: none draws what seeding would give it (its page,
      // marked, and its path); each draws its own, named once for each
      // address, with how many other frames its parent holds once its
      // parser has ended. Three at one path, then a lone one; a lone one,
      // taken out and another put in at its path; nine whose script
      // replaces parent before they draw; three where the first draws and
      // loads while its parent holds no other (the count is still 2).
      const { three, one } = r.drew.sandboxed;
      const seeded = (n, at) => expected(seed[n], at, new Map(), 't0x');
      assert.equal(new Set(Object.values(three).map((x) => x.uuid)).size, 3);
      for (const x of [...Object.values(three), one]) assert.notDeepEqual(x, seeded('sandboxed', '/fs'));
      const { first, again } = r.drew.lone;
      for (const x of [first, again]) assert.notDeepEqual(x, seeded('lone', '/fs'));
      assert.notEqual(first.uuid, again.uuid);
      const swapped = r.drew.swapped;
      assert.equal(new Set(Object.values(swapped).map((x) => x.uuid)).size, 9);
      for (const [k, at] of SWAP) for (let i = 0; i < 3; i++) assert.notDeepEqual(swapped[`${k}${i}`], seeded('swapped', at), `${k}${i}`);
      const held = r.drew.held;
      assert.equal(new Set(Object.values(held).map((x) => x.uuid)).size, 3);
      for (const x of Object.values(held)) assert.notDeepEqual(x, seeded('held', '/fh'));
      const nested = Object.values(r.drew.nested).flatMap((x) => [x.own, x.child]);
      assert.equal(new Set(nested.map((x) => x.uuid)).size, 4);
      assert.notEqual(r.drew.filled.b.uuid, r.drew.filled.y.uuid);
      sandboxed(r);
      // A page whose DOM changes often: seeding walks the document for no
      // change that puts in no frame, and once when one frame is put in.
      // The times are printed, not judged: a loaded machine moves them.
      console.log(`seeding cost in ${engine}, ms (least of two runs): ${JSON.stringify(Object.fromEntries(Object.entries(r.drew.cost).map(([k, t]) => [k, { seeded: Math.round(t.seeded), own: Math.round(t.own) }])))}`);
      for (const [kind, t] of Object.entries(r.drew.cost)) assert.deepEqual({ walks: t.walks, framed: t.framed, own: t.ownWalks }, { walks: [0, 0], framed: [1, 1], own: [0, 0] }, kind);
      // A replay draws what the record drew, frame by frame.
      kept = r.seeds;
      const p = await drawRun(j, env(rep.url), ['many.spec.ts'], names);
      for (const how of ['markup', 'script']) {
        assert.deepEqual(p.drew[how].errors, [], how);
        assert.deepEqual(p.drew[how].drew, r.drew[how].drew, how);
        assert.deepEqual(unplaced(p, how), [], how);
      }
      // Sandboxed frames draw the browser's own again, named as in the
      // record.
      assert.notDeepEqual(p.drew.sandboxed.one, one);
      assert.notDeepEqual(p.drew.sandboxed.three.s0, three.s0);
      assert.notDeepEqual(p.drew.lone.first, first);
      sandboxed(p);
    } finally { await rep.close(); await rec.close(); }
  });
}

for (const engine of ENGINES) {
  test(`seeded, in ${engine}: a sandboxed frame's line counts the frames beside it once its parent's parser has ended, not at its parent's load; or at the test's end, before its wait, when the parser has not ended by then; or at once, naming none, when its parent is removed`, async () => {
    const j = journal();
    const a = await fakeAgent(j);
    const d = await drawsServer();
    try {
      const { tests, out } = await playwright(['parse.spec.ts'], { ...keployEnv(a.url), PW_BROWSER: engine, DRAWS_BASE: d.url, PW_TIMEOUT: '15000' });
      // unloaded: counted at the parse's end, before the test put u2 in;
      // unparsed: at the test's end, u2 included. Each test then waits for
      // the call its page never had answered.
      for (const [n, others, call] of [['unloaded', 1, '/hold.png'], ['unparsed', 2, '/hold.js']]) {
        const t = tests[n];
        assert.equal(t.status, 'timedOut', `${n}: ${t.error}\n${out}`);
        const said = t.stdout.split('\n').filter((l) => l.startsWith(`keploy: in ${n}, `)).map((l) => l.replace(/:\d+\//, ':<port>/'));
        assert.deepEqual(said, [unplacedLine(n, 'http://127.0.0.1:<port>/fs', 'uncounted', others)], n);
        assert.ok(t.steps.some((s) => s.startsWith('keploy: wait for the test\'s 1 call(s) in flight') && s.endsWith(call)), `${n}: ${t.steps.join('\n')}`);
        // The line comes before that wait, not when the context closes.
        const line = t.order.findIndex((o) => o.out?.startsWith(`keploy: in ${n}, `));
        const wait = t.order.findIndex((o) => o.step?.startsWith('keploy: wait for the test\'s 1 call(s) in flight'));
        assert.ok(line >= 0 && line < wait, `${n}: ${JSON.stringify(t.order)}`);
      }
      // removed: the line comes once p is removed, before the test's next
      // step, and names no other frame: theirs are gone with p.
      const t = tests.removed;
      assert.equal(t.status, 'passed', `removed: ${t.error}\n${out}`);
      const said = t.stdout.split('\n').filter((l) => l.startsWith('keploy: in removed, ')).map((l) => l.replace(/:\d+\//, ':<port>/'));
      assert.deepEqual(said, [unplacedLine('removed', 'http://127.0.0.1:<port>/fs', 'uncounted', 0)]);
      const line = t.order.findIndex((o) => o.out?.startsWith('keploy: in removed, '));
      const next = t.order.findIndex((o) => o.step === 'p removed');
      assert.ok(line >= 0 && line < next, `removed: ${JSON.stringify(t.order)}`);
    } finally { await d.close(); await a.close(); }
  });
}

// The workers the page at /wk starts, in order: a classic and a module Web
// Worker, a classic Shared Worker, and module Shared Workers.
const WK_STARTS = [
  'new Worker(\'/wk/ded.js?x=1\')',
  'new Worker(\'/wk/mod.js\', { type: \'module\' })',
  'new SharedWorker(\'/wk/shared.js\', \'sn\')',
  'new SharedWorker(\'/wk/mshared.js\', { type: \'module\', name: \'mn\' })',
  'new SharedWorker(\'/wk/cshared.js\', { type: \'module\', name: \'c1\' })',
  'new SharedWorker(\'/wk/cshared.js\', { type: \'module\', name: \'c2\' })',
  'new SharedWorker(\'/wk/cshared.js\', { type: \'module\', name: \'c1\' })',
];

// The marks a document at /wk of page t0 gives the workers workers.spec.ts
// starts (WK_STARTS).
function workerMarks(seed) {
  const made = [];
  class Worker { constructor(url) { made.push(workerMark(String(url))); } }
  documentAt(initScript(seed), '/wk', new Map(), 't0', { globals: { URL, Worker, SharedWorker: Worker } })
    .run(WK_STARTS.map((s) => `${s};`).join(' '));
  return made;
}

for (const engine of ENGINES) {
  test(`seeded, in ${engine}: a page's classic and module Web Workers and its classic and module Shared Workers draw from the test's seed, the same at replay, a module Shared Worker whose policy refuses data: too (each connection that came before its script ran given to it, in order), at the app's location, URLs and stack, loading what sits beside them, and the app's server never sees keploy's mark; in Firefox each Shared Worker draws its own and is named`, async () => {
    const j = journal();
    const rec = await fakeAgent(j);
    let kept = {};
    const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
      ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
    const env = (url) => ({ ...keployEnv(url), PW_BROWSER: engine });
    const byKind = (r) => Object.fromEntries(r.drew.workers.map((w) => [w.kind, w]));
    try {
      const r = await drawRun(j, env(rec.url), ['workers.spec.ts'], ['workers']);
      const w = byKind(r);
      const [ded, mod, shared, mshared, c1, c2, c1again] = workerMarks(r.seeds.workers);
      assert.deepEqual([ded, mod, shared, mshared, c1, c2, c1again].map((m) => m.kind), ['w', 'm', 's', 'x', 'x', 'x', 'x']);
      assert.notEqual(c1.token, c2.token);
      assert.equal(c1again.token, c1.token);
      assert.match(w.ded.href, /^http:\/\/127\.0\.0\.1:\d+\/wk\/ded\.js\?x=1$/);
      assert.match(w.mod.href, /^http:\/\/127\.0\.0\.1:\d+\/wk\/mod\.js$/);
      assert.match(w.shared.href, /^http:\/\/127\.0\.0\.1:\d+\/wk\/shared\.js$/);
      assert.match(w.mshared.href, /^http:\/\/127\.0\.0\.1:\d+\/wk\/mshared\.js$/);
      for (const c of [w.c1, w.c2, w['c1+2']]) assert.match(c.href, /^http:\/\/127\.0\.0\.1:\d+\/wk\/cshared\.js$/);
      // The app's script runs at its own URL: its import.meta.url and a
      // stack through it show no mark.
      assert.match(w.mod.meta, /^http:\/\/127\.0\.0\.1:\d+\/wk\/mod\.js$/);
      assert.match(w.mshared.meta, /^http:\/\/127\.0\.0\.1:\d+\/wk\/mshared\.js$/);
      for (const c of [w.c1, w.c2, w['c1+2']]) assert.match(c.meta, /^http:\/\/127\.0\.0\.1:\d+\/wk\/cshared\.js$/);
      // No code of keploy's is on a stack through the app's script, at its
      // top level or in its handlers, held connections' too.
      const stacks = [['ded', 'stack', 'ded'], ['shared', 'stack', 'shared'], ['mod', 'top', 'mod'], ['mshared', 'top', 'mshared'],
        ...['c1', 'c2', 'c1+2'].flatMap((c) => [[c, 'top', 'cshared'], [c, 'stack', 'cshared']])];
      for (const [k, f, file] of stacks) {
        assert.match(w[k][f], new RegExp(`/wk/${file}\\.js[?:]`), `${k}.${f}: ${w[k][f]}`);
        assert.doesNotMatch(w[k][f], /__keploy_worker/, `${k}.${f}: ${w[k][f]}`);
      }
      // A message the page posts as it starts a Web Worker reaches the app's
      // handler: the app's script has run before the worker takes it.
      assert.deepEqual([w['ded-early'], w['mod-early']], [{ kind: 'ded-early', data: 'early' }, { kind: 'mod-early', data: 'early' }]);
      assert.deepEqual([w.ded.dep, w.mod.dep, w.mshared.dep, w.c1.dep, w.c2.dep, w['c1+2'].dep], ['dep', 'lib', 'lib', 'lib', 'lib', 'lib']);
      // c1's second connection is c1's worker's: what it drew as it loaded.
      assert.deepEqual(w['c1+2'].draws, w.c1.draws);
      assert.deepEqual(w.ded.draws, workerAt('http://h/wk/ded.js?x=1', workerScript(ded.token, 0, 'w')).draws());
      assert.deepEqual(w.mod.draws, workerAt('http://h/wk/mod.js', workerScript(mod.token, 0, 'm')).draws());
      const model = workerAt('http://h/wk/shared.js', workerScript(shared.token, 0, 's')).draws();
      const mmodel = workerAt('http://h/wk/mshared.js', workerScript(mshared.token, 0, 'x')).draws();
      const cmodel = [c1, c2].map((m) => workerAt('http://h/wk/cshared.js', workerScript(m.token, 0, 'x')).draws());
      const said = r.tests.workers.stdout.split('\n').filter((l) => l.startsWith('keploy: in workers, ')).map((l) => l.replace(/:\d+\//, ':<port>/'));
      const at = (p) => `http://127.0.0.1:<port>/wk/${p}`;
      // Every engine: each Shared Worker script's address, once, is not waited for.
      const unwaited = ['shared.js', 'mshared.js', 'cshared.js'].map((p) => sharedWorkerLine('workers', at(p)));
      if (engine === 'firefox') {
        assert.notDeepEqual(w.shared.draws, model);
        assert.notDeepEqual(w.mshared.draws, mmodel);
        assert.notDeepEqual([w.c1.draws, w.c2.draws], cmodel);
        assert.deepEqual(said.sort(), [...['shared.js', 'mshared.js', 'cshared.js'].map((p) => unplacedLine('workers', at(p), 'shared')), ...unwaited].sort());
      } else {
        assert.deepEqual(w.shared.draws, model);
        assert.deepEqual(w.mshared.draws, mmodel);
        assert.deepEqual([w.c1.draws, w.c2.draws], cmodel);
        assert.deepEqual(said.sort(), [...unwaited].sort());
      }
      // What the app's server was asked for: never keploy's mark, and each
      // worker's script and what it loads.
      assert.deepEqual(r.seen.filter((u) => u.includes('__keploy_worker')), []);
      for (const u of ['/wk/ded.js?x=1', '/wk/dep.js', '/wk/mod.js', '/wk/lib.mjs', '/wk/shared.js', '/wk/mshared.js', '/wk/cshared.js']) assert.ok(r.seen.includes(u), `${u}: ${r.seen.join(' ')}`);
      kept = r.seeds;
      const q = await drawRun(j, env(rep.url), ['workers.spec.ts'], ['workers']);
      const p = byKind(q);
      assert.deepEqual([p.ded.draws, p.mod.draws], [w.ded.draws, w.mod.draws]);
      for (const k of ['shared', 'mshared']) {
        if (engine === 'firefox') assert.notDeepEqual(p[k].draws, w[k].draws, k);
        else assert.deepEqual(p[k].draws, w[k].draws, k);
      }
      for (const k of ['c1', 'c2']) {
        if (engine === 'firefox') assert.notDeepEqual(p[k].draws, w[k].draws, k);
        else assert.deepEqual(p[k].draws, w[k].draws, k);
      }
      assert.deepEqual(q.seen.filter((u) => u.includes('__keploy_worker')), []);
    } finally { await rep.close(); await rec.close(); }
  });
}

test('seeded: keploy answers no seed (an older recording, or an older keploy): the browser draws its own, each test says so, and its end says own', async () => {
  const j = journal();
  const a = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' ? { body: { v: 1, status: 'ok' } } : undefined));
  try {
    const r1 = await drawRun(j, keployEnv(a.url));
    const r2 = await drawRun(j, keployEnv(a.url));
    for (const n of ['one', 'two', 'again', 'three']) assert.notDeepEqual(r2.drew[n], r1.drew[n], n);
    assert.notDeepEqual(r1.drew.one.top, expected(r1.seeds.one, '/draws'));
    for (const r of [r1, r2]) {
      assert.equal(r.said, 0);
      for (const n of ['one', 'two', 'again']) assert.ok(r.tests[n].stdout.split('\n').includes(unseededLine(n)), `${n}: ${r.tests[n].stdout}`);
      assert.ok(!r.tests['own › three'].stdout.includes('with no seed'), r.tests['own › three'].stdout);
      assert.deepEqual(r.ends, NAMES.map((n) => [n, 'own']));
    }
    // A test with no page says own too: it asked for a seed and got none.
    const from = j.events.length;
    await playwright(['basic.spec.ts'], keployEnv(a.url));
    const ends = j.events.slice(from).filter((e) => e.agent && e.agent.path === '/agent/scope/end').map((e) => e.agent.body.random);
    assert.deepEqual(ends, ['own', 'own', 'own', 'own']);
  } finally { await a.close(); }
});

test('a page the test\'s context already holds when keploy\'s fixture gets it is the test\'s: its end says seeded, or own with seeding off; a test that takes the context and opens no page says neither', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const d = await drawsServer();
  try {
    for (const [env, want] of [[{}, 'seeded'], [{ KEPLOY_SEED_RANDOM: 'off' }, 'own']]) {
      const from = j.events.length;
      const { tests, out } = await playwright(['opened.spec.ts'], { ...keployEnv(a.url), DRAWS_BASE: d.url, ...env });
      for (const n of ['held page', 'no page']) assert.equal(tests[n].status, 'passed', `${n}: ${out}`);
      const ends = j.events.slice(from).filter((e) => e.agent && e.agent.path === '/agent/scope/end').map((e) => [e.agent.body.name, e.agent.body.random]);
      assert.deepEqual(ends, [['held page', want], ['no page', undefined]], `${want}: ${out}`);
    }
  } finally { await d.close(); await a.close(); }
});

test('seeded: keploySeedRandom: false for the whole project asks no seed, says once what that costs, and the browser draws its own', async () => {
  const j = journal();
  // An agent that answers a seed even to a begin that asked for none: the
  // test that opted out still draws the browser's own numbers.
  const a = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' ? { body: { v: 1, status: 'ok', seed: '0123456789abcdef' } } : undefined));
  try {
    const r1 = await drawRun(j, { ...keployEnv(a.url), PW_NOSEED: '1' });
    const r2 = await drawRun(j, { ...keployEnv(a.url), PW_NOSEED: '1' });
    for (const n of ['one', 'two', 'again', 'three']) assert.notDeepEqual(r2.drew[n], r1.drew[n], n);
    for (const r of [r1, r2]) {
      assert.equal(r.said, 0);
      assert.deepEqual(r.lines.filter((l) => l.startsWith('keploy:')), [OFF_LINE], r.lines.join('\n'));
      assert.deepEqual(r.begins.map((b) => [b.random, b.seed]), Array(4).fill(['own', undefined]));
      assert.deepEqual(r.ends, NAMES.map((n) => [n, 'own']));
    }
  } finally { await a.close(); }
});

test('KEPLOY_SEED_RANDOM=off, or no keploy: the test browser draws its own random numbers; under keploy the worker says once what that costs, without it nothing is said', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    for (const [env, said] of [[{ ...keployEnv(a.url), KEPLOY_SEED_RANDOM: 'off' }, [OFF_LINE]], [{ KEPLOY_MOCK_AGENT: undefined, KEPLOY_TEST_PID: undefined }, []]]) {
      const r1 = await drawRun(j, env);
      const r2 = await drawRun(j, env);
      for (const n of ['one', 'two', 'again', 'three']) assert.notDeepEqual(r2.drew[n], r1.drew[n], n);
      assert.equal(r1.said + r2.said, 0);
      for (const r of [r1, r2]) assert.deepEqual(r.lines.filter((l) => l.startsWith('keploy:')), said, r.lines.join('\n'));
    }
    // Under keploy with it off, each begin says the browser draws its own
    // and sends no seed, and each end says it did.
    assert.deepEqual(calls(j).filter((c) => c.path === '/agent/scope/begin').map((c) => [c.body.random, c.body.seed]), Array(8).fill(['own', undefined]));
    assert.deepEqual(calls(j).filter((c) => c.path === '/agent/scope/end').map((c) => c.body.random), Array(8).fill('own'));
  } finally { await a.close(); }
});

test('KEPLOY_SEED_RANDOM neither on nor off fails every test, naming it, and the worker claims nothing', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const d = await drawsServer();
  try {
    const { tests } = await playwright(['seeded.spec.ts'], { ...keployEnv(a.url), KEPLOY_SEED_RANDOM: 'yes', DRAWS_BASE: d.url });
    assert.equal(Object.keys(tests).length, 4);
    for (const [k, t] of Object.entries(tests)) {
      assert.equal(t.status, 'failed', k);
      assert.match(t.error, /keploy: KEPLOY_SEED_RANDOM="yes" is neither on nor off; set it to off to give the test browser and the test process their own random numbers, or unset it to seed them per test/, k);
    }
    assert.deepEqual(calls(j), []);
  } finally { await d.close(); await a.close(); }
});

// One run of process.spec.ts: what each test drew in the test process, what
// code outside every test drew, what the run said, and the seed each begin
// sent.
async function processRun(j, env) {
  const from = j.events.length;
  const { tests, tmp, out } = await playwright(['process.spec.ts'], env);
  for (const [k, t] of Object.entries(tests)) assert.equal(t.status, 'passed', `${k}: ${t.error}\n${out}`);
  const drew = {};
  for (const n of ['made', 'other', 'mine', 'outside']) drew[n] = JSON.parse(fs.readFileSync(path.join(tmp, `${n}.json`), 'utf8'));
  // Every line the run's tests said, in no order: the report lists a
  // describe group's tests before the file's own.
  const lines = Object.values(tests).map((t) => t.stdout).join('').split('\n').sort();
  const begins = calls({ events: j.events.slice(from) }).filter((c) => c.path === '/agent/scope/begin').map((c) => c.body);
  const seeds = Object.fromEntries(begins.map((b) => [b.name.replace(/^own › /, ''), b.seed]));
  return { drew, lines, seeds, out };
}

test('seeded: the test process draws Math.random from its test\'s seed in its beforeEach, body and afterEach, so a replay makes the data its recording made; another test, an opted-out one and code outside every test draw others', async () => {
  const j = journal();
  const rec = await fakeAgent(j);
  let kept = {};
  const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
    ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
  try {
    const r = await processRun(j, keployEnv(rec.url));
    kept = r.seeds;
    // Four draws a test: its beforeEach, two in its body, its afterEach,
    // each from the stream of the seed keploy answered its begin with.
    for (const n of ['made', 'other']) {
      const next = processRandom(r.seeds[n]);
      assert.deepEqual(r.drew[n], [next(), next(), next(), next()], n);
    }
    assert.equal(r.drew.mine.length, 4);
    assert.equal(r.seeds.mine, undefined);
    assert.notDeepEqual(r.drew.made, r.drew.other);
    // Said once each: the seeding at the first seeded test, the cost at the
    // opted-out one.
    assert.deepEqual(r.lines.filter((l) => l.startsWith('keploy:')), [SEEDED_LINE, OFF_LINE].sort(), r.out);
    const p = await processRun(j, keployEnv(rep.url));
    // The replay's begins sent fresh seeds; keploy answered the recording's.
    for (const n of ['made', 'other']) {
      assert.notEqual(p.seeds[n], kept[n], n);
      assert.deepEqual(p.drew[n], r.drew[n], n);
    }
    // The opted-out test and the code after the last test draw the worker's own.
    assert.notDeepEqual(p.drew.mine, r.drew.mine);
    assert.notDeepEqual(p.drew.outside.draws, r.drew.outside.draws);
    for (const x of [r, p]) assert.equal(x.drew.outside.own, true);
    // A record made again draws new numbers.
    const r2 = await processRun(j, keployEnv(rec.url));
    assert.notDeepEqual(r2.drew.made, r.drew.made);
  } finally { await rep.close(); await rec.close(); }
});

// One run of faker.spec.ts (CommonJS) and faker-esm.spec.mts (an ES
// module): what each test made with faker, and the seed each begin sent.
async function fakerRun(j, env) {
  const from = j.events.length;
  const { tests, tmp, out } = await playwright(['faker.spec.ts', 'faker-esm.spec.mts'], env);
  for (const [k, t] of Object.entries(tests)) assert.equal(t.status, 'passed', `${k}: ${t.error}\n${out}`);
  const made = {};
  for (const n of ['made', 'other', 'mine', 'itself', 'outside', 'esm made', 'own']) made[n] = JSON.parse(fs.readFileSync(path.join(tmp, `faker-${n}.json`), 'utf8'));
  const begins = calls({ events: j.events.slice(from) }).filter((c) => c.path === '/agent/scope/begin').map((c) => c.body);
  const seeds = Object.fromEntries(begins.map((b) => [b.name.replace(/^own › /, ''), b.seed]));
  return { made, seeds, out };
}

test('seeded: faker\'s instances in the test process make from the test\'s seed in its beforeEach, body and afterEach, in a CommonJS test file and an ES module one, so a replay makes the data its recording made, and so do the suite\'s own instances given to seedFaker or made in a test; another test, an opted-out one, a test that seeds faker itself, code outside every test and an own instance not given make others', async () => {
  const j = journal();
  const rec = await fakeAgent(j);
  let kept = {};
  const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
    ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
  try {
    const r = await fakerRun(j, keployEnv(rec.url));
    kept = r.seeds;
    // An ID and a name in each of the beforeEach, the body and the afterEach.
    assert.equal(r.made.made.length, 6);
    assert.notDeepEqual(r.made.made, r.made.other);
    assert.equal(r.seeds.mine, undefined);
    const p = await fakerRun(j, keployEnv(rep.url));
    for (const n of ['made', 'other', 'esm made']) {
      assert.notEqual(p.seeds[n], kept[n], n);
      assert.deepEqual(p.made[n], r.made[n], n);
    }
    // The suite's own instances: one given to seedFaker as the file loads and
    // one made in the test make the recording's data; one not given, its own.
    assert.notEqual(p.seeds['own instances'], kept['own instances']);
    assert.equal(r.made['esm made'].length, 3);
    assert.deepEqual(p.made.own.mine, r.made.own.mine);
    assert.equal(p.made.own.inTest, r.made.own.inTest);
    assert.notEqual(p.made.own.notGiven, r.made.own.notGiven);
    // The opted-out test and the code after the last test make the worker's own.
    assert.notDeepEqual(p.made.mine, r.made.mine);
    assert.notDeepEqual(p.made.outside.made, r.made.outside.made);
    for (const x of [r, p]) assert.equal(x.made.outside.own, true);
    // A test that seeds an instance itself draws what that seed gives.
    const { fakerFR } = await import('@faker-js/faker');
    fakerFR.seed(7);
    const want = fakerFR.number.int();
    for (const x of [r, p]) assert.deepEqual(x.made.itself, [want, want]);
    // A record made again makes new data.
    const r2 = await fakerRun(j, keployEnv(rec.url));
    assert.notDeepEqual(r2.made.made, r.made.made);
    assert.notDeepEqual(r2.made['esm made'], r.made['esm made']);
    assert.notDeepEqual(r2.made.own.mine, r.made.own.mine);
  } finally { await rep.close(); await rec.close(); }
});

test('the test process draws its own Math.random when keploy answers no seed, each test saying so, or with KEPLOY_SEED_RANDOM=off, the worker saying once what that costs', async () => {
  const j = journal();
  const none = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' ? { body: { v: 1, status: 'ok' } } : undefined));
  const rec = await fakeAgent(j);
  try {
    for (const [env, said] of [
      [keployEnv(none.url), [unseededLine('made'), unseededLine('other'), OFF_LINE]],
      [{ ...keployEnv(rec.url), KEPLOY_SEED_RANDOM: 'off' }, [OFF_LINE]],
    ]) {
      const r1 = await processRun(j, env);
      const r2 = await processRun(j, env);
      for (const n of ['made', 'other', 'mine']) assert.notDeepEqual(r2.drew[n], r1.drew[n], n);
      for (const r of [r1, r2]) {
        assert.equal(r.drew.outside.own, true);
        assert.deepEqual(r.lines.filter((l) => l.startsWith('keploy:')), said.sort(), r.out);
      }
    }
  } finally { await rec.close(); await none.close(); }
});

// One run of process-order.spec.ts (spec args after the file, as --grep):
// what each test drew, each test's status, the lines its tests said, and the
// seed each begin sent.
const ORDER = ['first', 'second', 'third'];
async function orderRun(j, env, args = []) {
  const from = j.events.length;
  const { tests, tmp, out } = await playwright(['process-order.spec.ts', ...args], env);
  const drew = {};
  for (const n of ORDER) {
    const f = path.join(tmp, `${n}.json`);
    drew[n] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  const status = Object.fromEntries(Object.entries(tests).map(([k, t]) => [k, t.status]));
  const lines = Object.values(tests).map((t) => t.stdout).join('').split('\n').filter((l) => l.startsWith('keploy:')).sort();
  const seeds = Object.fromEntries(calls({ events: j.events.slice(from) }).filter((c) => c.path === '/agent/scope/begin').map((c) => [c.body.name, c.body.seed]));
  return { drew, status, lines, seeds, out };
}

for (const helper of ['step', 'stack']) {
  test(`seeded: a test's draws in the test process do not depend on which tests its worker ran before it, when its helper file's source map is parsed in it (${helper === 'step' ? 'test.step' : 'an Error\'s stack'}): replayed alone, after keploy set an earlier test aside, or after its record's first test failed, it draws what its recording drew`, async () => {
    const j = journal();
    const rec = await fakeAgent(j);
    let kept = {};
    // A replay answers each begin the recording's seed, and sets aside the
    // tests named in skip, as keploy does a quarantined one.
    let skip = [];
    const rep = await fakeAgent(j, (c) => {
      if (c.path !== '/agent/scope/begin') return undefined;
      if (skip.includes(c.body.name)) return { body: { v: 1, status: 'ok', action: 'skip', reason: 'flaky/request_changed: the body changed' } };
      return { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } };
    });
    const env = (url, x = {}) => ({ ...keployEnv(url), HELPER: helper, ...x });
    const same = (p, r, names) => Object.fromEntries(names.map((n) => [n, JSON.stringify(p.drew[n]) === JSON.stringify(r.drew[n]) ? 'same' : 'other']));
    try {
      const r = await orderRun(j, env(rec.url));
      assert.deepEqual(r.status, { first: 'passed', second: 'passed', third: 'passed' }, r.out);
      // Each test's two draws are its seed's stream's first two: the
      // first test, which parsed the helper's map, too.
      for (const n of ORDER) {
        const next = processRandom(r.seeds[n]);
        assert.deepEqual(r.drew[n], [next(), next()], n);
      }
      // Seeded, with no test opting out: the seeding line once, nothing else.
      assert.deepEqual(r.lines, [SEEDED_LINE], r.out);
      kept = r.seeds;
      const alone = await orderRun(j, env(rep.url), ['--grep', 'third']);
      assert.deepEqual(alone.status, { third: 'passed' }, alone.out);
      assert.deepEqual(same(alone, r, ['third']), { third: 'same' });
      skip = ['first'];
      const aside = await orderRun(j, env(rep.url));
      assert.deepEqual(aside.status, { first: 'skipped', second: 'passed', third: 'passed' }, aside.out);
      assert.deepEqual(same(aside, r, ['second', 'third']), { second: 'same', third: 'same' });
      skip = [];
      // A record whose first test fails runs the rest in a new worker; its
      // replay, where the first passes, runs all three in one.
      const rf = await orderRun(j, env(rec.url, { FAIL_FIRST: '1' }));
      assert.deepEqual(rf.status, { first: 'failed', second: 'passed', third: 'passed' }, rf.out);
      kept = rf.seeds;
      const pf = await orderRun(j, env(rep.url));
      assert.deepEqual(pf.status, { first: 'passed', second: 'passed', third: 'passed' }, pf.out);
      assert.deepEqual(same(pf, rf, ['second', 'third']), { second: 'same', third: 'same' });
    } finally { await rep.close(); await rec.close(); }
  });
}

// One run of process-worker.spec.ts, as orderRun runs process-order's.
async function workerRun(j, env, args = []) {
  const from = j.events.length;
  const { tests, tmp, out } = await playwright(['process-worker.spec.ts', ...args], env);
  const drew = {};
  for (const n of [...ORDER, 'broken', 'pst']) {
    const f = path.join(tmp, `${n}.json`);
    drew[n] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  const status = Object.fromEntries(Object.entries(tests).map(([k, t]) => [k, t.status]));
  const seeds = Object.fromEntries(calls({ events: j.events.slice(from) }).filter((c) => c.path === '/agent/scope/begin').map((c) => [c.body.name, c.body.seed]));
  return { drew, status, seeds, tests, out };
}

test('seeded: a worker fixture set up in the first test that asks for it draws the worker\'s own Math.random, so a test draws what its recording drew when replayed alone or after keploy set an earlier test aside; a test fixture draws from its test\'s stream', async () => {
  const j = journal();
  const rec = await fakeAgent(j);
  let kept = {};
  let skip = [];
  const rep = await fakeAgent(j, (c) => {
    if (c.path !== '/agent/scope/begin') return undefined;
    if (skip.includes(c.body.name)) return { body: { v: 1, status: 'ok', action: 'skip', reason: 'flaky/request_changed: the body changed' } };
    return { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } };
  });
  const same = (p, r, names) => Object.fromEntries(names.map((n) => [n, JSON.stringify(p.drew[n]) === JSON.stringify(r.drew[n]) ? 'same' : 'other']));
  try {
    for (const how of ['extend', 'use']) {
      const env = (url) => ({ ...keployEnv(url), USE_ACCOUNT: how === 'use' ? '1' : undefined });
      const r = await workerRun(j, env(rec.url));
      assert.deepEqual(r.status, { first: 'passed', second: 'passed', third: 'passed' }, r.out);
      // Each test's draws are its stream's first ones: the first test's
      // lead (a test fixture) first, then its body's; account (set up in
      // the first test) and team (in the third) take none of them.
      const firsts = (n, k) => { const next = processRandom(r.seeds[n]); return Array.from({ length: k }, () => next()); };
      const [l, a, b] = firsts('first', 3);
      assert.deepEqual(r.drew.first, [`lead-${l}`, a, b], how);
      assert.deepEqual(r.drew.second, firsts('second', 2), how);
      // A plain value and an option are given as they were written.
      assert.deepEqual(r.drew.third, [...firsts('third', 2), 'a', 'x'], how);
      // Playwright names each fixture at the line that registered it, in the
      // spec, not in this package.
      // So it is through use with no formatter set and a stack trace limit
      // of 0; extend and use leave Error.prepareStackTrace and the limit as
      // they found them.
      const line = how === 'use' ? 28 : 15;
      assert.equal(r.tests.first.at['Fixture "account"'], `process-worker.spec.ts:${line}`, how);
      assert.equal(r.tests.third.at['Fixture "team"'], 'process-worker.spec.ts:15', how);
      assert.deepEqual(r.drew.pst, { extend: { same: true, limit: true }, ...(how === 'use' ? { use: { absent: true, limit: true } } : {}) }, how);
      if (how === 'use') continue;
      kept = r.seeds;
      for (const n of ['second', 'third']) {
        const alone = await workerRun(j, env(rep.url), ['--grep', n]);
        assert.deepEqual(alone.status, { [n]: 'passed' }, alone.out);
        assert.deepEqual(same(alone, r, [n]), { [n]: 'same' });
      }
      skip = ['first'];
      const aside = await workerRun(j, env(rep.url));
      assert.deepEqual(aside.status, { first: 'skipped', second: 'passed', third: 'passed' }, aside.out);
      assert.deepEqual(same(aside, r, ['second', 'third']), { second: 'same', third: 'same' });
      skip = [];
    }
    // A worker fixture that fails before use() leaves the rest of its test
    // (its afterEach) drawing the test's stream.
    const bk = await workerRun(j, { ...keployEnv(rec.url), BROKEN: '1' }, ['--grep', 'broken']);
    assert.deepEqual(bk.status, { broken: 'failed' }, bk.out);
    assert.deepEqual(bk.drew.broken, [processRandom(bk.seeds.broken)()]);
  } finally { await rep.close(); await rec.close(); }
});

test('the test process draws its own Math.random when keploy answers no seed and no test opts out: each test says so, and nothing else is said', async () => {
  const j = journal();
  const none = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' ? { body: { v: 1, status: 'ok' } } : undefined));
  try {
    const r1 = await orderRun(j, { ...keployEnv(none.url), HELPER: 'step' });
    const r2 = await orderRun(j, { ...keployEnv(none.url), HELPER: 'step' });
    for (const n of ORDER) assert.notDeepEqual(r2.drew[n], r1.drew[n], n);
    for (const r of [r1, r2]) assert.deepEqual(r.lines, ORDER.map((n) => unseededLine(n)).sort(), r.out);
  } finally { await none.close(); }
});

test('seeded: after a test that throws, and after one that times out, the worker draws its own Math.random again', async () => {
  const j = journal();
  const rec = await fakeAgent(j);
  try {
    const { tests, tmp, out } = await playwright(['process-ends.spec.ts'], keployEnv(rec.url));
    assert.deepEqual(Object.fromEntries(Object.entries(tests).map(([k, t]) => [k, t.status])), { throws: 'failed', 'times out': 'timedOut' }, out);
    for (const n of ['after throws', 'after times out']) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, `${n}.json`), 'utf8')), { own: true }, n);
    }
    // Both were seeded: each began with a seed.
    const begins = calls(j).filter((c) => c.path === '/agent/scope/begin').map((c) => c.body);
    assert.deepEqual(begins.map((b) => [b.name, b.random, /^[0-9a-f]{32}$/.test(b.seed)]), [['throws', 'seeded', true], ['times out', 'seeded', true]]);
  } finally { await rec.close(); }
});
