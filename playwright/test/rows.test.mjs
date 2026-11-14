// Rows: real Playwright runs of test/fixtures against a fake keploy agent,
// which records every call and answers as each row says. The settle rows
// need Chromium (npx playwright install chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'node_modules', '@playwright', 'test', 'cli.js');
const CONFIG = path.join(PKG, 'test', 'fixtures', 'playwright.config.ts');

// What happened, in order, across the fake agent and the page server.
function journal() {
  const events = [];
  return { events, add: (e) => events.push(e) };
}

// A fake keploy agent. answer(call) returns {status, body} or undefined for
// the protocol's plain "ok".
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
    if (req.url === '/release') { release(); res.end('ok'); return; }
    if (req.url === '/seen') { void seen.then(() => res.end('ok')); return; }
    // A service worker that calls /slow as it installs.
    if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end("self.addEventListener('install', () => { void fetch('/slow'); });"); return; }
    if (req.url === '/nocontent') { res.writeHead(204); res.end(); return; }
    if (req.url === '/resetcontent') { res.writeHead(205); res.end(); return; }
    if (req.url === '/inline-attachment-name') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-disposition': 'inline; filename="attachment-page.html"' });
      res.end('<html><body>inline page</body></html>');
      return;
    }
    // A disposition's type is case-insensitive (RFC 6266): the browser downloads "Attachment" too.
    if (req.url === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'Attachment; filename="d.bin"' }); res.end('bytes'); return; }
    // An unknown disposition type is handled as attachment (RFC 6266, section 4.2), even for HTML.
    if (req.url === '/download-x') { res.writeHead(200, { 'content-type': 'text/html', 'content-disposition': 'x-attachment; filename="a.html"' }); res.end('<html></html>'); return; }
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
      const t = spec.tests[0];
      const r = t.results[t.results.length - 1] ?? {};
      tests[[...titles, spec.title].join(' › ')] = {
        status: r.status ?? 'none',
        error: (r.errors ?? []).map((e) => e.message ?? '').join('\n'),
        annotations: r.annotations ?? t.annotations ?? [],
        steps: steps.filter((x) => x.test === spec.title).map((x) => x.step),
      };
    }
  };
  for (const s of JSON.parse(fs.readFileSync(report, 'utf8')).suites) walk(s, []);
  return { tests, tmp, out };
}

const keployEnv = (url) => ({ KEPLOY_MOCK_AGENT: url, KEPLOY_MOCK_AGENT_TOKEN: 'tok', KEPLOY_MOCK_PROJECT: PKG, KEPLOY_TEST_PID: undefined });
const calls = (j) => j.events.filter((e) => e.agent).map((e) => e.agent);
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
    assert.deepEqual(calls(j).map((c) => [c.path, c.body]), [
      ['/agent/instance', claim],
      ['/agent/scope/begin', { ...r('a'), canSkip: true }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('a'), outcome: 'passed' }],
      ['/agent/scope/begin', { ...r('b'), canSkip: true }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('b'), outcome: 'failed' }],
      ['/agent/instance', claim],
      ['/agent/scope/begin', { ...r('c'), canSkip: true }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('c'), outcome: 'skipped' }],
      ['/agent/scope/begin', { ...r('d'), canSkip: true }], ['/agent/scope/given', given], ['/agent/scope/end', { ...r('d'), outcome: 'passed' }],
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

test('settle: an inline document with attachment in its filename still replaces the page', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  const p = await pageServer(j);
  try {
    const { tests, out } = await playwright(['settle.spec.ts', '-g', 'inline document with attachment in its filename'], { ...keployEnv(a.url), SLOW_BASE: p.url, NO_RELEASE: '1', PW_TIMEOUT: '4000' });
    const title = 'a call its page cancelled by loading an inline document with attachment in its filename';
    assert.equal(tests[title].status, 'passed', JSON.stringify({ result: tests[title], events: j.events }));
    const order = j.events.map((e) => (e.page ? e.page : e.agent.path));
    assert.deepEqual(order.filter((e) => e.startsWith('slow') || e === '/agent/scope/end'), ['slow sent', 'slow cut', '/agent/scope/end']);
  } finally { await p.close(); await a.close(); }
});

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
    assert.deepEqual(calls(j).map((c) => [c.path, c.body]), [
      ['/agent/instance', { key: '.', dir: fs.realpathSync(PKG) }],
      ['/agent/scope/begin', { ...r, canSkip: true }],
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
    assert.deepEqual(calls(j).map((c) => [c.path, c.body]), [
      ['/agent/instance', { key: 'p1', dir: fs.realpathSync(PKG) }],
      ['/agent/scope/begin', { ...r, canSkip: true }],
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
    assert.deepEqual(calls(j).map((c) => [c.path, c.body]), [
      ['/agent/instance', { key: 'p1', dir: fs.realpathSync(cwd) }],
      ['/agent/scope/begin', { ...r, canSkip: true }],
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
  ['a call in flight across an unknown disposition type download', 'a navigation answered with an unknown disposition type (a download, "x-attachment") replaces no document', '/slow'],
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
