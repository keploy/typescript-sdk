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
import { LOADS_KEY, SEEDED_LINE, initScript, unplacedLine, unseededLine } from '../dist/random.js';
import { BLANK_DRAWS, DRAWS, documentAt } from './draws.mjs';

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
    if (req.url === '/release') { release(); res.end('ok'); return; }
    if (req.url === '/seen') { void seen.then(() => res.end('ok')); return; }
    // A service worker that calls /slow as it installs.
    if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end("self.addEventListener('install', () => { void fetch('/slow'); });"); return; }
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
        stdout: (r.stdout ?? []).map((x) => x.text ?? Buffer.from(x.buffer ?? '', 'base64').toString()).join(''),
      };
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
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'text/html' });
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
    if (['/fa', '/fb', '/fc', '/fw'].includes(u.pathname)) { res.end(page(u.pathname)); return; }
    res.end('');
  });
  // Every address: the frame is asked for at localhost, which may be ::1.
  await new Promise((r) => srv.listen(0, r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
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
    return { drew, said, lines, tests, tmp, begins, ends, seeds };
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
  test(`seeded, in ${engine}: frames of a first document each draw their own numbers, never their parent's, numbered at the path their element asks for, one put where a removed frame was, one in an open shadow root and one drawn from after its removal too; one in a closed shadow root has no place; a first document's popup is placed in Chromium only, else named; the test's own context init script is named as the test's`, async () => {
    const j = journal();
    const rec = await fakeAgent(j);
    let kept = {};
    const rep = await fakeAgent(j, (c) => (c.path === '/agent/scope/begin' && c.body.seed
      ? { body: { v: 1, status: 'ok', ...(kept[c.body.name] ? { seed: kept[c.body.name] } : {}) } } : undefined));
    const names = ['frames', 'popupfromblank', 'ownctxinit', 'shadow', 'removed'];
    const unplaced = (r, n) => r.tests[n].stdout.split('\n').filter((l) => l.startsWith(`keploy: in ${n}, `)).map((l) => l.replace(/:\d+\//, ':<port>/')).sort();
    const env = (url) => ({ ...keployEnv(url), PW_BROWSER: engine });
    try {
      const r = await drawRun(j, env(rec.url), ['engines.spec.ts'], names);
      const at = (id, where, seed = r.seeds.frames) => JSON.parse(JSON.stringify(documentAt(initScript(seed), where, null, id).run(BLANK_DRAWS)));
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
      // A popup the first document opens with window.open('about:blank'):
      // Chromium places it; Firefox and WebKit begin its document before
      // window.open returns, so it has no place there, and is named.
      const pop = r.drew.popupfromblank;
      assert.equal(pop.url, 'about:blank');
      const placed = engine === 'chromium';
      if (placed) assert.deepEqual(pop.draws, at(`${r.seeds.popupfromblank}\nt0\nblank\n0\nw0`, 'blank', r.seeds.popupfromblank));
      assert.deepEqual(unplaced(r, 'popupfromblank'), placed ? [] : [unplacedLine('popupfromblank', 'about:blank', 'popup')]);
      // The test's own context init script draws first in each document of
      // its page, its first about:blank too: named as the test's, with the
      // reason.
      assert.deepEqual(unplaced(r, 'ownctxinit'), ['about:blank', 'http://127.0.0.1:<port>/draws', 'http://localhost:<port>/frame'].map((a) => unplacedLine('ownctxinit', a, 'own')).sort());
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
      if (placed) assert.deepEqual(p.drew.popupfromblank, pop);
      else assert.notDeepEqual(p.drew.popupfromblank.draws, pop.draws);
      assert.notEqual(p.drew.ownctxinit.early, r.drew.ownctxinit.early);
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
      assert.deepEqual(r.drew.race, { r0: ex('race', '/fr', `${race}f/fr\n0`), r1: ex('race', '/fr', `${race}f/fr\n1`) });
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

test('seeded: a retry draws the numbers its first attempt drew, from the seed keploy answers it', async () => {
  const j = journal();
  // keploy answers a retry's begin in the same record with the first
  // attempt's seed.
  const first = new Map();
  const a = await fakeAgent(j, (c) => {
    if (c.path !== '/agent/scope/begin' || !c.body.seed) return undefined;
    if (!first.has(c.body.name)) first.set(c.body.name, c.body.seed);
    return { body: { v: 1, status: 'ok', seed: first.get(c.body.name) } };
  });
  try {
    const r = await drawRun(j, keployEnv(a.url), ['retry.spec.ts', '--retries=1'], ['flips-0', 'flips-1']);
    assert.equal(r.begins.length, 2);
    assert.notEqual(r.begins[1].seed, r.begins[0].seed);
    assert.deepEqual(r.drew['flips-0'], expected(r.begins[0].seed, '/draws'));
    assert.deepEqual(r.drew['flips-1'], r.drew['flips-0']);
    assert.deepEqual(r.ends, [['flips', 'seeded'], ['flips', 'seeded']]);
  } finally { await a.close(); }
});

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

test('seeded: keploySeedRandom: false for the whole project asks no seed, says nothing, and the browser draws its own', async () => {
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
      assert.equal(r.lines.filter((l) => l.startsWith('keploy:')).length, 0, r.lines.join('\n'));
      assert.deepEqual(r.begins.map((b) => [b.random, b.seed]), Array(4).fill(['own', undefined]));
      assert.deepEqual(r.ends, NAMES.map((n) => [n, 'own']));
    }
  } finally { await a.close(); }
});

test('KEPLOY_SEED_RANDOM=off, or no keploy: the test browser draws its own random numbers, and nothing is said', async () => {
  const j = journal();
  const a = await fakeAgent(j);
  try {
    for (const env of [{ ...keployEnv(a.url), KEPLOY_SEED_RANDOM: 'off' }, { KEPLOY_MOCK_AGENT: undefined, KEPLOY_TEST_PID: undefined }]) {
      const r1 = await drawRun(j, env);
      const r2 = await drawRun(j, env);
      for (const n of ['one', 'two', 'again', 'three']) assert.notDeepEqual(r2.drew[n], r1.drew[n], n);
      assert.equal(r1.said + r2.said, 0);
      assert.equal([...r1.lines, ...r2.lines].filter((l) => l.startsWith('keploy:')).length, 0);
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
      assert.match(t.error, /keploy: KEPLOY_SEED_RANDOM="yes" is neither on nor off; set it to off to give the test browser its own random numbers, or unset it to seed them per test/, k);
    }
    assert.deepEqual(calls(j), []);
  } finally { await d.close(); await a.close(); }
});
