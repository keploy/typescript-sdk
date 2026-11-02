// Unit rows: the agent client, the join rule and the pure helpers, against a
// fake agent. No Jest run (rows.test.mjs runs Jest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AgentClient, KeployError } from '../dist/agent.js';
import { decide } from '../dist/join.js';
import { createRequire } from 'node:module';
import { jestRuns, testRef, outcomeOf, keployText, isCircus } from '../dist/index.js';


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

test('a claim answered with a plain 404 names the route and the switch keploy speaks the protocol under; keploy\'s own 404 shows keploy\'s reason', async () => {
  let a = await agent(() => ({ status: 404, body: '404 page not found' }));
  try {
    await rejects(new AgentClient(a.url, '').claim('p', '/d'), /^keploy: this keploy agent answered 404 to POST \/agent\/instance, so this Jest process cannot claim keploy's run: keploy speaks @keploy\/jest's wire, scope protocol v1, only when it runs with KEPLOY_PROVEN=1 \(KEPLOY_PROVEN=1 keploy mock record\|replay -c "npx jest -i"\); a keploy run without KEPLOY_PROVEN=1, or one from before scope protocol v1, answers 404 there$/);
  } finally { await a.close(); }
  // A 404 that carries keploy's own refusal is keploy's answer, not a missing route.
  a = await agent(() => ({ status: 404, body: { error: 'no_instance', message: 'no run to claim', remedy: 'start keploy mock record' } }));
  try {
    await rejects(new AgentClient(a.url, '').claim('p', '/d'), /^keploy: no run to claim \(start keploy mock record\)$/);
  } finally { await a.close(); }
  // Any other plain answer keeps the generic text.
  a = await agent(() => ({ status: 500, body: 'boom' }));
  try {
    await rejects(new AgentClient(a.url, '').claim('p', '/d'), /^keploy: the keploy agent answered 500 Internal Server Error to \/agent\/instance: "boom"$/);
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

test('keployText: keploy\'s reason once prefixed, or the fallback when it gave none', () => {
  assert.equal(keployText('keploy: GET /a had no recorded answer', 'fb'), 'keploy: GET /a had no recorded answer');
  assert.equal(keployText('flaky/request_changed: the body changed', 'fb'), 'keploy: flaky/request_changed: the body changed');
  assert.equal(keployText('', 'keploy: fb'), 'keploy: fb');
  assert.equal(keployText(undefined, 'keploy: fb'), 'keploy: fb');
  // Only the whole word with its separator counts as keploy's prefix.
  assert.equal(keployText('keploy:x', 'fb'), 'keploy: keploy:x');
});

// A jest-circus tree: root (no parent) > describe > test.
function tree({ testMode, describeMode } = {}) {
  const root = { name: 'ROOT_DESCRIBE_BLOCK' };
  const d = { name: 'orders', parent: root, mode: describeMode };
  const t = { name: 'pays', parent: d, mode: testMode, errors: [] };
  return t;
}

test('jestRuns: jest-circus\'s own rule (own and ancestor skip, todo, focus, the -t pattern)', () => {
  assert.equal(jestRuns(tree(), {}), true);
  assert.equal(jestRuns(tree({ testMode: 'skip' }), {}), false);
  assert.equal(jestRuns(tree({ testMode: 'todo' }), {}), false);
  assert.equal(jestRuns(tree({ describeMode: 'skip' }), {}), false);
  // Focus: only a test whose mode is set (only) runs.
  assert.equal(jestRuns(tree(), { hasFocusedTests: true }), false);
  assert.equal(jestRuns(tree({ testMode: 'only' }), { hasFocusedTests: true }), true);
  // The -t pattern matches the titles joined by spaces, from the outermost describe.
  assert.equal(jestRuns(tree(), { testNamePattern: /^orders pays$/ }), true);
  assert.equal(jestRuns(tree(), { testNamePattern: /refunds/ }), false);
});

test('testRef: the file relative to the project, the titles joined by › from the outermost describe, the project when named', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kj-')));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    const file = path.join(dir, 'src', 'a.test.js');
    fs.writeFileSync(file, '');
    assert.deepEqual(testRef(tree(), file, dir, ''), { name: 'orders › pays', file: 'src/a.test.js' });
    assert.deepEqual(testRef(tree(), file, dir, 'api'), { name: 'orders › pays', file: 'src/a.test.js', project: 'api' });
    const top = { name: 'top', parent: { name: 'ROOT_DESCRIBE_BLOCK' }, errors: [] };
    assert.deepEqual(testRef(top, file, dir, ''), { name: 'top', file: 'src/a.test.js' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('outcomeOf: failed when the test holds an error, else passed', () => {
  assert.equal(outcomeOf({ errors: [] }), 'passed');
  assert.equal(outcomeOf({ errors: [new Error('x')] }), 'failed');
});

test('isCircus: the testRunner\'s nearest named package.json names jest-circus', () => {
  // Jest's default, resolved as Jest resolves it.
  assert.equal(isCircus(createRequire(import.meta.url).resolve('jest-circus/runner')), true);
  assert.equal(isCircus(undefined), false);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kj-circus-')));
  const put = (f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
  try {
    // A package.json with no name (one that sets "type"), or none that
    // reads, names no package: the walk goes on up.
    put('circus/package.json', '{"name":"jest-circus"}');
    put('circus/build/package.json', '{"type":"commonjs"}');
    put('circus/build/runner.js', '');
    put('circus/lib/package.json', '{');
    put('circus/lib/runner.js', '');
    assert.equal(isCircus(path.join(dir, 'circus/build/runner.js')), true);
    assert.equal(isCircus(path.join(dir, 'circus/lib/runner.js')), true);
    // A folder named jest-circus inside another package is that package.
    put('other/package.json', '{"name":"my-runner"}');
    put('other/jest-circus/runner.js', '');
    assert.equal(isCircus(path.join(dir, 'other/jest-circus/runner.js')), false);
    // No package.json up to the root.
    put('none/runner.js', '');
    assert.equal(isCircus(path.join(dir, 'none/runner.js')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
