// Unit rows: the agent client, the join rule, the wire names and settle's
// wake, against a fake agent and a fake browser context. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AgentClient, KeployError } from '../dist/agent.js';
import { decide } from '../dist/join.js';
import { Inflight } from '../dist/settle.js';
import { EventEmitter } from 'node:events';
import { testRef, outcomeOf, sourceOf, keployText } from '../dist/index.js';

// One fake agent answering every call with answer(path, body).
async function agent(answer) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const call = { path: req.url, auth: req.headers.authorization ?? '', body: body ? JSON.parse(body) : null };
      calls.push(call);
      const a = answer(call);
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json', ...(a.headers ?? {}) });
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, calls, close: () => new Promise((r) => srv.close(r)) };
}

async function rejects(p, re) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof KeployError, `not a KeployError: ${err}`);
    assert.match(err.message, re);
    return true;
  });
}

test('the client sends the token and the protocol body, and takes v1 answers', async () => {
  const a = await agent(({ path: p }) => ({ body: p === '/agent/instance' ? { v: 1, instance: 'run', timeFile: '/tmp/k/t' } : { v: 1, status: 'ok' } }));
  try {
    const c = new AgentClient(a.url + '/', 'tok');
    await c.claim('chromium', '/proj');
    await c.begin({ name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium' });
    await c.end({ name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium' }, 'passed');
    assert.deepEqual(a.calls.map((x) => [x.path, x.auth, x.body]), [
      ['/agent/instance', 'Bearer tok', { key: 'chromium', dir: '/proj' }],
      ['/agent/scope/begin', 'Bearer tok', { name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium', canSkip: true }],
      ['/agent/scope/end', 'Bearer tok', { name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium', outcome: 'passed' }],
    ]);
  } finally { await a.close(); }
});

test('no token: no authorization header', async () => {
  const a = await agent(() => ({ body: { v: 1, status: 'ok' } }));
  try {
    await new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' });
    assert.equal(a.calls[0].auth, '');
  } finally { await a.close(); }
});

test('every answer the client cannot trust is an error', async () => {
  const cases = [
    [{ body: { status: 'ok' } }, /names no scope protocol version.*upgrade keploy/],
    [{ body: { v: 2, status: 'ok' } }, /scope protocol v2.*same release/],
    [{ body: 'not json' }, /cannot be read/],
    [{ body: '[1]' }, /cannot be read \(not an object\)/],
    [{ body: 'null' }, /cannot be read \(not an object\)/],
    [{ status: 422, body: { error: 'one_test_at_a_time', message: 'b began while a was still open', remedy: 'run them one at a time' } },
      /^keploy: b began while a was still open \(run them one at a time\)$/],
    [{ status: 400, body: { error: 'bad_request', message: 'invalid' } }, /^keploy: invalid$/],
    [{ status: 500, body: 'boom' }, /answered 500 .* to \/agent\/scope\/begin: "boom"/],
    [{ status: 302, body: '' }, /answered 302/],
    [{ body: { v: 1, status: 'busy' } }, /begin of a with status "busy"/],
    [{ body: { v: 1, status: 'ok', action: 'fail' } }, /begin of a with the unknown action "fail"/],
  ];
  for (const [answer, re] of cases) {
    const a = await agent(() => answer);
    try {
      await rejects(new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' }), re);
    } finally { await a.close(); }
  }
});

test('a redirect from the agent is an error, and is not followed', async () => {
  // Following it would send the call again, or to somewhere else.
  const a = await agent(({ path: p }) => (p === '/elsewhere' ? { body: { v: 1, status: 'ok' } }
    : { status: 307, headers: { location: '/elsewhere' }, body: '' }));
  try {
    await rejects(new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' }), /answered 307 Temporary Redirect to \/agent\/scope\/begin/);
    assert.deepEqual(a.calls.map((x) => x.path), ['/agent/scope/begin']);
  } finally { await a.close(); }
});

test('an end answered with a status other than ok is an error', async () => {
  const a = await agent(() => ({ body: { v: 1, status: 'busy' } }));
  try {
    await rejects(new AgentClient(a.url, '').end({ name: 'a', file: 'a.spec.ts' }, 'passed'), /end of a with status "busy"/);
  } finally { await a.close(); }
});

test('an end takes only fail as its action', async () => {
  const a = await agent(() => ({ body: { v: 1, status: 'ok', action: 'skip' } }));
  try {
    await rejects(new AgentClient(a.url, '').end({ name: 'a', file: 'a.spec.ts' }, 'passed'), /end of a with the unknown action "skip"/);
  } finally { await a.close(); }
});

test('a claim without an instance is refused', async () => {
  const a = await agent(() => ({ body: { v: 1 } }));
  try {
    await rejects(new AgentClient(a.url, '').claim('p', '/d'), /without an instance/);
  } finally { await a.close(); }
});

test('an unreachable agent is an error', async () => {
  const a = await agent(() => ({ body: {} }));
  await a.close();
  await rejects(new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' }), /cannot reach the keploy agent/);
});

test('an answer over 1 MiB is an error', async () => {
  const a = await agent(() => ({ body: JSON.stringify({ v: 1, status: 'ok', reason: 'x'.repeat(1 << 20) }) }));
  try {
    await rejects(new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' }), /larger than 1048576 bytes/);
  } finally { await a.close(); }
});

test('given: the variable comes back; an agent without the route names the route, the keploy version that serves it and the switch, and keploy\'s own 404 shows keploy\'s reason', async () => {
  let a = await agent(() => ({ body: { v: 1, status: 'ok', variable: 'given:session' } }));
  try {
    assert.equal(await new AgentClient(a.url, '').given('session', 'tok-1', 'tests/a.spec.ts:3'), 'given:session');
    assert.deepEqual(a.calls[0].body, { name: 'session', value: 'tok-1', source: 'tests/a.spec.ts:3' });
  } finally { await a.close(); }
  a = await agent(() => ({ status: 404, body: '404 page not found' }));
  try {
    await rejects(new AgentClient(a.url, '').given('session', 'tok-1', ''), /^keploy: this keploy agent answered 404 to POST \/agent\/scope\/given, so it cannot take the given value session: given needs keploy v3\.6\.192 or later \(keploy\/keploy#5016\), or an enterprise release on keploy v3\.6\.192 or later, run with KEPLOY_PROVEN=1; an older keploy, or one run without KEPLOY_PROVEN=1, answers 404 there$/);
  } finally { await a.close(); }
  // A 404 that carries keploy's own refusal is keploy's answer, not a missing route.
  a = await agent(() => ({ status: 404, body: { error: 'no_test', message: 'no test named a is open', remedy: 'begin it first' } }));
  try {
    await rejects(new AgentClient(a.url, '').given('session', 'tok-1', ''), /^keploy: no test named a is open \(begin it first\)$/);
  } finally { await a.close(); }
  a = await agent(() => ({ status: 422, body: { error: 'not_open', message: 'a value was given while no test was open' } }));
  try {
    await rejects(new AgentClient(a.url, '').given('session', 'tok-1', ''), /^keploy: a value was given while no test was open$/);
  } finally { await a.close(); }
  for (const body of [{ v: 1, status: 'ok' }, { v: 1, status: 'ok', variable: '' }, { v: 1, status: 'busy', variable: 'given:session' }]) {
    a = await agent(() => ({ body }));
    try {
      await rejects(new AgentClient(a.url, '').given('session', 'tok-1', ''), /answered the given value session with/);
    } finally { await a.close(); }
  }
});

// A fake browser context for Inflight: the events it listens to, and nothing
// else. A page's frame names its page; a service worker's request has none.
function fakeContext() {
  const ctx = new EventEmitter();
  ctx.pages = () => [];
  return ctx;
}
function fakeRequest(page) {
  const frame = page ? { page: () => page } : null;
  return {
    frame: () => { if (!frame) throw new Error('no frame'); return frame; },
    isNavigationRequest: () => false,
    method: () => 'GET',
    url: () => 'http://localhost/slow',
  };
}
// Lets every resolved promise's callbacks run; no timer.
async function ticks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('settle: a cancel that comes while settle already waits wakes it (its page closes; then, for a service worker\'s call, the test closes its context)', async () => {
  for (const worker of [false, true]) {
    const c = worker ? 'a page\'s call and a service worker\'s' : 'a page\'s call';
    const ctx = fakeContext();
    const inflight = new Inflight(ctx);
    const page = new EventEmitter();
    const other = new EventEmitter();
    ctx.emit('page', page);
    ctx.emit('page', other);
    ctx.emit('request', fakeRequest(page));
    if (worker) ctx.emit('request', fakeRequest(null));
    let settled = false;
    inflight.settled().then(() => { settled = true; });
    await ticks();
    assert.equal(settled, false, `${c}: settle waits for the call in flight`);
    // Another page closing cancels none of these calls.
    other.emit('close');
    await ticks();
    assert.equal(settled, false, `${c}: another page's close leaves settle waiting`);
    page.emit('close');
    await ticks();
    if (worker) {
      // The page's close drops only its own call: the service worker's has
      // no page, so settle still waits, until the test closes its context.
      assert.equal(inflight.size, 1, `${c}: the page's close leaves the service worker's call`);
      assert.equal(settled, false, `${c}: settle still waits for the service worker's call`);
      ctx.emit('close');
      await ticks();
    }
    assert.equal(inflight.size, 0, `${c}: no call is left in flight`);
    assert.equal(settled, true, `${c}: settle is woken`);
  }
});

test('decide: inert, refused, active', () => {
  const never = () => { throw new Error('runsInside called'); };
  assert.deepEqual(decide({}, 10, never), { mode: 'inert' });
  assert.deepEqual(decide({ KEPLOY_MOCK_AGENT: ' OFF ' }, 10, never), { mode: 'inert' });
  assert.equal(decide({ KEPLOY_MOCK_AGENT: 'localhost:16789' }, 10, never).mode, 'refused');
  assert.equal(decide({ KEPLOY_MOCK_AGENT: 'ftp://h' }, 10, never).mode, 'refused');
  assert.deepEqual(decide({ KEPLOY_MOCK_AGENT: 'http://127.0.0.1:16789/', KEPLOY_MOCK_AGENT_TOKEN: 't', KEPLOY_MOCK_PROJECT: '/p' }, 10, never),
    { mode: 'active', url: 'http://127.0.0.1:16789', token: 't', project: '/p' });
  // A process inside the claimer (the browser, a helper) stays inert; a
  // marker naming no ancestor, or this process, is no claim of another.
  const env = { KEPLOY_MOCK_AGENT: 'http://a:1', KEPLOY_TEST_PID: '7' };
  assert.deepEqual(decide(env, 10, (p) => p === 7), { mode: 'inert' });
  assert.equal(decide(env, 10, () => false).mode, 'active');
  assert.equal(decide({ ...env, KEPLOY_TEST_PID: '10' }, 10, never).mode, 'active');
  assert.equal(decide({ ...env, KEPLOY_TEST_PID: 'x' }, 10, never).mode, 'active');
});

test('testRef: the file relative to the project, the titles after it, the project when named', () => {
  const ti = { file: path.join(process.cwd(), 'tests', 'a.spec.ts'), titlePath: ['a.spec.ts', 'group', 'inner', 'title'], project: { name: 'chromium' } };
  assert.deepEqual(testRef(ti, process.cwd()), { name: 'group › inner › title', file: 'tests/a.spec.ts', project: 'chromium' });
  assert.deepEqual(testRef({ ...ti, project: { name: '' } }, process.cwd()), { name: 'group › inner › title', file: 'tests/a.spec.ts' });
  // A spec reached through a symbolic link is named by its real path, as the
  // project directory is.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kpw-ref-')));
  try {
    fs.mkdirSync(path.join(root, 'proj', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proj', 'tests', 'a.spec.ts'), '');
    fs.symlinkSync(path.join(root, 'proj', 'tests'), path.join(root, 'linked'));
    assert.deepEqual(testRef({ ...ti, file: path.join(root, 'linked', 'a.spec.ts') }, path.join(root, 'proj')),
      { name: 'group › inner › title', file: 'tests/a.spec.ts', project: 'chromium' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('outcomeOf: the test\'s own verdict', () => {
  assert.equal(outcomeOf({ status: 'passed', expectedStatus: 'passed' }), 'passed');
  assert.equal(outcomeOf({ status: 'failed', expectedStatus: 'passed' }), 'failed');
  assert.equal(outcomeOf({ status: 'timedOut', expectedStatus: 'passed' }), 'failed');
  assert.equal(outcomeOf({ status: 'interrupted', expectedStatus: 'passed' }), 'failed');
  assert.equal(outcomeOf({ status: 'skipped', expectedStatus: 'skipped' }), 'skipped');
  assert.equal(outcomeOf({ status: 'skipped', expectedStatus: 'passed' }), 'skipped');
  // test.fail(): failing is its pass, passing its failure.
  assert.equal(outcomeOf({ status: 'failed', expectedStatus: 'failed' }), 'passed');
  assert.equal(outcomeOf({ status: 'passed', expectedStatus: 'failed' }), 'failed');
});

test('sourceOf: the first frame outside the package, relative to the project', () => {
  const own = path.resolve('dist', 'index.js');
  const stack = ['Error', `    at given (${own}:10:5)`, '    at /proj/tests/a.spec.ts:12:7', '    at node:internal/x:1:1'].join('\n');
  assert.equal(sourceOf(stack, '/proj'), 'tests/a.spec.ts:12');
  assert.equal(sourceOf(['Error', '    at Object.<anonymous> (/proj/t/b.spec.ts:3:1)'].join('\n'), '/proj'), 't/b.spec.ts:3');
  assert.equal(sourceOf(['Error', '    at x (file:///proj/t/c.spec.mjs:4:2)'].join('\n'), '/proj'), 't/c.spec.mjs:4');
  assert.equal(sourceOf('Error\n    at <anonymous>', '/proj'), '');
});

test('keployText: keploy\'s reason once prefixed, or the fallback when it gave none', () => {
  assert.equal(keployText('keploy: GET /a had no recorded answer', 'fb'), 'keploy: GET /a had no recorded answer');
  assert.equal(keployText('flaky/request_changed: the body changed', 'fb'), 'keploy: flaky/request_changed: the body changed');
  assert.equal(keployText('', 'keploy: fb'), 'keploy: fb');
  assert.equal(keployText(undefined, 'keploy: fb'), 'keploy: fb');
  // Only the whole word with its separator counts as keploy's prefix.
  assert.equal(keployText('keploy:x', 'fb'), 'keploy: keploy:x');
});
