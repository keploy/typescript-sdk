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
import { Inflight, sharedWorkerScript } from '../dist/settle.js';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { testRef, outcomeOf, sourceOf, keployText, runAgain } from '../dist/index.js';

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
    await c.begin({ name: 'g › b', file: 'tests/a.spec.ts' }, 'seeded');
    await c.begin({ name: 'g › c', file: 'tests/a.spec.ts' }, 'own');
    await c.begin({ name: 'g › d', file: 'tests/a.spec.ts' }, 'seeded', '0123abcd');
    await c.end({ name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium' }, 'passed');
    await c.end({ name: 'g › d', file: 'tests/a.spec.ts' }, 'failed', 'own');
    assert.deepEqual(a.calls.map((x) => [x.path, x.auth, x.body]), [
      ['/agent/instance', 'Bearer tok', { key: 'chromium', dir: '/proj' }],
      ['/agent/scope/begin', 'Bearer tok', { name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium', canSkip: true }],
      ['/agent/scope/begin', 'Bearer tok', { name: 'g › b', file: 'tests/a.spec.ts', canSkip: true, random: 'seeded' }],
      ['/agent/scope/begin', 'Bearer tok', { name: 'g › c', file: 'tests/a.spec.ts', canSkip: true, random: 'own' }],
      ['/agent/scope/begin', 'Bearer tok', { name: 'g › d', file: 'tests/a.spec.ts', canSkip: true, random: 'seeded', seed: '0123abcd' }],
      ['/agent/scope/end', 'Bearer tok', { name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium', outcome: 'passed' }],
      ['/agent/scope/end', 'Bearer tok', { name: 'g › d', file: 'tests/a.spec.ts', outcome: 'failed', random: 'own' }],
    ]);
  } finally { await a.close(); }
});

test('a begin\'s answer gives the seed keploy answered, or none', async () => {
  for (const [body, seed] of [[{ v: 1, status: 'ok', seed: '0123abcd' }, '0123abcd'], [{ v: 1, status: 'ok', seed: '' }, ''], [{ v: 1, status: 'ok' }, undefined]]) {
    const a = await agent(() => ({ body }));
    try {
      const b = await new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' }, 'seeded', 'ffffffff');
      assert.equal(b.seed, seed);
    } finally { await a.close(); }
  }
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
    // A seed keploy would not keep, or one that is no string.
    [{ body: { v: 1, status: 'ok', seed: 'not-hex-at-all' } }, /^keploy: the keploy agent answered the begin of a with the seed "not-hex-at-all", which is no seed keploy keeps \(8 to 64 lower-case hex digits\)$/],
    [{ body: { v: 1, status: 'ok', seed: '0123ABCD' } }, /with the seed "0123ABCD", which is no seed/],
    [{ body: { v: 1, status: 'ok', seed: '0123abc' } }, /with the seed "0123abc", which is no seed/],
    [{ body: { v: 1, status: 'ok', seed: 12345678 } }, /with the seed "12345678", which is no seed/],
    [{ body: { v: 1, status: 'ok', seed: null } }, /with the seed "null", which is no seed/],
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
    await rejects(new AgentClient(a.url, '').claim('p', '/d'), /^keploy: this keploy agent answered 404 to POST \/agent\/instance, so this worker cannot claim keploy's run: keploy speaks @keploy\/playwright's wire, scope protocol v1, only when it runs with KEPLOY_PROVEN=1 \(KEPLOY_PROVEN=1 keploy mock record\|replay -c "npx playwright test --workers=1 --retries=0"\); a keploy run without KEPLOY_PROVEN=1, or one from before scope protocol v1, answers 404 there$/);
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

test('a begin, an end or a refusal answered with a plain 404 names the route and the switch, as the claim does; keploy\'s own 404 shows keploy\'s reason', async () => {
  const t = { name: 'g › a', file: 'a.spec.ts' };
  const proven = (route, what) => new RegExp(`^keploy: this keploy agent answered 404 to POST ${route.replace(/\//g, '\\/')}, so ${what}: ` +
    'keploy speaks @keploy\\/playwright\'s wire, scope protocol v1, only when it runs with KEPLOY_PROVEN=1 ' +
    '\\(KEPLOY_PROVEN=1 keploy mock record\\|replay -c "npx playwright test --workers=1 --retries=0"\\); ' +
    'a keploy run without KEPLOY_PROVEN=1, or one from before scope protocol v1, answers 404 there$');
  const calls = [
    [(c) => c.begin(t), proven('/agent/scope/begin', 'g › a cannot begin')],
    [(c) => c.end(t, 'passed'), proven('/agent/scope/end', 'g › a cannot end')],
    [(c) => c.refuse('test_run_again', 'm', 'r'), proven('/agent/refusal', 'keploy cannot be told of the refusal')],
  ];
  for (const [call, re] of calls) {
    let a = await agent(() => ({ status: 404, body: '404 page not found' }));
    try {
      await rejects(call(new AgentClient(a.url, '')), re);
    } finally { await a.close(); }
    a = await agent(() => ({ status: 404, body: { error: 'not_open', message: 'g › a is not open', remedy: 'begin it first' } }));
    try {
      await rejects(call(new AgentClient(a.url, '')), /^keploy: g › a is not open \(begin it first\)$/);
    } finally { await a.close(); }
    // Any other plain answer keeps the generic text.
    a = await agent(() => ({ status: 500, body: 'boom' }));
    try {
      await rejects(call(new AgentClient(a.url, '')), /^keploy: the keploy agent answered 500 Internal Server Error to \/agent\/[a-z/]+: "boom"$/);
    } finally { await a.close(); }
  }
});

test('refuse sends the code, the message and the remedy, and takes only ok', async () => {
  let a = await agent(() => ({ body: { v: 1, status: 'ok' } }));
  try {
    await new AgentClient(a.url, 'tok').refuse('test_run_again', 'Playwright retried a', 'run with --retries=0');
    assert.deepEqual(a.calls.map((x) => [x.path, x.auth, x.body]),
      [['/agent/refusal', 'Bearer tok', { code: 'test_run_again', message: 'Playwright retried a', remedy: 'run with --retries=0' }]]);
  } finally { await a.close(); }
  for (const body of [{ v: 1 }, { v: 1, status: 'busy' }]) {
    a = await agent(() => ({ body }));
    try {
      await rejects(new AgentClient(a.url, '').refuse('test_run_again', 'm', 'r'), /^keploy: the keploy agent answered the refusal test_run_again with status "(busy)?"$/);
    } finally { await a.close(); }
  }
});

test('runAgain: a retry and a repeat of --repeat-each are refused, naming the test by its keploy ID; a first run is not', () => {
  const ref = { name: 'g › a', file: 'tests/a.spec.ts', project: 'chromium' };
  assert.equal(runAgain(ref, { retry: 0, repeatEachIndex: 0 }), null);
  const retry = { message: 'Playwright retried chromium::tests/a.spec.ts::g › a, and keploy runs each test once in a run',
    remedy: 'run the suite with --retries=0, and with no retries in its config or its test.describe.configure' };
  assert.deepEqual(runAgain(ref, { retry: 1, repeatEachIndex: 0 }), retry);
  // The message names no attempt: the agent keeps one refusal per test.
  assert.deepEqual(runAgain(ref, { retry: 2, repeatEachIndex: 0 }), retry);
  assert.deepEqual(runAgain(ref, { retry: 1, repeatEachIndex: 1 }), retry);
  assert.deepEqual(runAgain({ name: 'g › a', file: 'tests/a.spec.ts' }, { retry: 0, repeatEachIndex: 1 }), {
    message: 'Playwright ran tests/a.spec.ts::g › a again for --repeat-each, and keploy runs each test once in a run',
    remedy: 'run the suite without --repeat-each, and with no repeatEach in its config' });
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

test('given: the variable comes back; an agent without the route names the route and the keploy version that serves it, and keploy\'s own 404 shows keploy\'s reason', async () => {
  let a = await agent(() => ({ body: { v: 1, status: 'ok', variable: 'given:session' } }));
  try {
    assert.equal(await new AgentClient(a.url, '').given('session', 'tok-1', 'tests/a.spec.ts:3'), 'given:session');
    assert.deepEqual(a.calls[0].body, { name: 'session', value: 'tok-1', source: 'tests/a.spec.ts:3' });
  } finally { await a.close(); }
  a = await agent(() => ({ status: 404, body: '404 page not found' }));
  try {
    await rejects(new AgentClient(a.url, '').given('session', 'tok-1', ''), /^keploy: this keploy agent answered 404 to POST \/agent\/scope\/given, so it cannot take the given value session: given needs keploy v3\.6\.192 or later \(keploy\/keploy#5016\), or an enterprise release on keploy v3\.6\.192 or later; an older keploy answers 404 there$/);
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

test('settle: a call keploy\'s route answered has ended, though the browser reports no end (Chromium, a Shared Worker\'s script); one reported after its answer is not waited for', async () => {
  const ctx = fakeContext();
  const inflight = new Inflight(ctx);
  const page = new EventEmitter();
  ctx.emit('page', page);
  const script = fakeRequest(page);
  const other = fakeRequest(page);
  ctx.emit('request', script);
  ctx.emit('request', other);
  let settled = false;
  inflight.settled().then(() => { settled = true; });
  inflight.answered(script);
  await ticks();
  assert.equal(inflight.size, 1);
  assert.equal(settled, false);
  ctx.emit('requestfinished', other);
  await ticks();
  assert.equal(settled, true);
  const late = fakeRequest(page);
  inflight.answered(late);
  ctx.emit('request', late);
  assert.equal(inflight.size, 0);
});

test('settle: a request of the frame that started a Shared Worker at its script\'s URL (fragment aside), reported before or after, is not waited for; one of another frame, another URL, or a navigation is', async () => {
  const call = (frame, url, nav = false) => ({ frame: () => frame, isNavigationRequest: () => nav, method: () => 'GET', url: () => url });
  const ctx = fakeContext();
  const inflight = new Inflight(ctx);
  const page = new EventEmitter();
  ctx.emit('page', page);
  const f = { page: () => page };
  const g = { page: () => page };
  const before = call(f, 'http://h/s.js?q=1#a');
  const waited = [call(g, 'http://h/s.js?q=1'), call(f, 'http://h/s.js'), call(f, 'http://h/s.js?q=1', true)];
  ctx.emit('request', before);
  for (const r of waited) ctx.emit('request', r);
  let settled = false;
  inflight.settled().then(() => { settled = true; });
  inflight.sharedWorker(f, 'http://h/s.js?q=1#b');
  await ticks();
  assert.equal(inflight.size, 3);
  // A second Shared Worker of that frame, at another URL: both are kept.
  inflight.sharedWorker(f, 'http://h/t.js');
  ctx.emit('request', call(f, 'http://h/s.js?q=1'));
  ctx.emit('request', call(f, 'http://h/s.js?q=1#c'));
  ctx.emit('request', call(f, 'http://h/t.js'));
  assert.equal(inflight.size, 3);
  for (const r of waited) {
    assert.equal(settled, false);
    ctx.emit('requestfinished', r);
    await ticks();
  }
  assert.equal(settled, true);
  // With nothing else in flight, the frame's report wakes settle.
  const ctx2 = fakeContext();
  const one = new Inflight(ctx2);
  ctx2.emit('request', call(f, 'http://h/s.js'));
  let woke = false;
  one.settled().then(() => { woke = true; });
  one.sharedWorker(f, 'http://h/s.js');
  await ticks();
  assert.deepEqual([woke, one.size], [true, 0]);
});

test('sharedWorkerScript: the page\'s SharedWorker starts each worker as asked, then reports its script URL against the document\'s base with no fragment; the binding leaves the window; a worker the browser refuses throws its own error and reports nothing; new, instanceof, constructor, name and length kept; with no binding the browser\'s own stays', () => {
  const made = [];
  const told = [];
  class Base {}
  class SharedWorker extends Base { constructor(url, o) { super(); if (String(url) === 'http://[' || String(url).endsWith('/refused.js')) throw new SyntaxError('the browser\'s own'); made.push([url, o]); } }
  const ctx = { URL, document: { baseURI: 'http://h/a/p' }, location: { href: 'http://h/b/p' }, __r: (u) => { told.push(u); return Promise.reject(new Error('gone')); } };
  // As a window's: not enumerable; the wrapper keeps the property's flags.
  Object.defineProperty(ctx, 'SharedWorker', { value: SharedWorker, writable: true, enumerable: false, configurable: true });
  vm.createContext(ctx);
  vm.runInContext(sharedWorkerScript('__r'), ctx);
  assert.equal(vm.runInContext('typeof __r', ctx), 'undefined');
  const o = { name: 'n', type: 'module' };
  ctx.o = o;
  vm.runInContext('globalThis.w = new SharedWorker("s.js?q=1#f", o)', ctx);
  assert.deepEqual(made, [['s.js?q=1#f', o]]);
  assert.equal(made[0][1], o);
  assert.deepEqual(told, ['http://h/a/s.js?q=1']);
  assert.equal(vm.runInContext('w instanceof SharedWorker && SharedWorker.prototype.constructor === SharedWorker && SharedWorker.name === "SharedWorker" && SharedWorker.length === 1', ctx), true);
  assert.equal(vm.runInContext('const d = Object.getOwnPropertyDescriptor(globalThis, "SharedWorker"); JSON.stringify([d.enumerable, d.writable, d.configurable])', ctx), '[false,true,true]');
  assert.equal(Object.getPrototypeOf(ctx.SharedWorker), Base);
  for (const u of ['http://[', '/refused.js']) assert.throws(() => vm.runInContext(`new SharedWorker(${JSON.stringify(u)})`, ctx), (e) => e.message === 'the browser\'s own', u);
  assert.throws(() => vm.runInContext('SharedWorker("/s.js")', ctx), TypeError);
  assert.equal(told.length, 1);
  // A window with no document yet: its location.
  delete ctx.document;
  vm.runInContext('new SharedWorker("s.js")', ctx);
  assert.deepEqual(told, ['http://h/a/s.js?q=1', 'http://h/b/s.js']);
  // A report that throws: the worker is still the app's.
  const c2 = { URL, SharedWorker, location: { href: 'http://h/p' }, __r: () => { throw new Error('gone'); } };
  vm.createContext(c2);
  vm.runInContext(sharedWorkerScript('__r'), c2);
  assert.equal(vm.runInContext('new SharedWorker("/s.js") instanceof SharedWorker', c2), true);
  // No binding: the browser's own stays.
  const c3 = { URL, SharedWorker, location: { href: 'http://h/p' } };
  vm.createContext(c3);
  vm.runInContext(sharedWorkerScript('__r'), c3);
  assert.equal(c3.SharedWorker, SharedWorker);
});

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

test('settle: a frame that is gone drops only its own calls, its own document request too, and wakes settle once none is left', async () => {
  // Two frames of one page, each with a call Playwright reports no end for
  // once the frame is gone, and each with its own document still loading.
  const ctx = fakeContext();
  const inflight = new Inflight(ctx);
  const page = new EventEmitter();
  ctx.emit('page', page);
  const a = { page: () => page };
  const b = { page: () => page };
  const beacon = (frame, url) => ({ frame: () => frame, isNavigationRequest: () => false, method: () => 'POST', url: () => url });
  const doc = (frame, url) => ({ frame: () => frame, isNavigationRequest: () => true, method: () => 'GET', url: () => url });
  ctx.emit('request', doc(a, 'http://localhost/slowdoc'));
  ctx.emit('request', beacon(a, 'http://localhost/a'));
  ctx.emit('request', doc(b, 'http://localhost/bdoc'));
  ctx.emit('request', beacon(b, 'http://localhost/b'));
  let settled = false;
  inflight.settled().then(() => { settled = true; });
  await ticks();
  page.emit('framedetached', a);
  await ticks();
  assert.deepEqual(inflight.describe(), ['GET http://localhost/bdoc', 'POST http://localhost/b'], 'the gone frame\'s calls are dropped, its document request too; the other frame\'s call and document request are not');
  assert.equal(settled, false, 'settle still waits for the other frame\'s calls');
  page.emit('framedetached', b);
  await ticks();
  assert.equal(inflight.size, 0, 'no call is left in flight');
  assert.equal(settled, true, 'settle is woken');
});

// A frame's request, its navigation's, and the navigation's answer.
function frameRequest(frame, url, nav = false) {
  return { frame: () => frame, isNavigationRequest: () => nav, method: () => 'GET', url: () => `http://localhost${url}` };
}
function answer(request, status = 200, headers = {}) {
  return { request: () => request, status: () => status, headers: () => headers };
}

// Firefox can report a call the new document makes as it loads (here an
// image its parser asks for) before it reports the frame's commit: the
// order a Firefox run gave, made exact. The commit drops only the calls
// reported before the new document's answer, the old document's, one
// started while the navigation ran included; the new document's call is
// waited for. A redirect's answer is not the document's: a call reported
// after it, before the final answer, is still the old document's.
test('settle: a frame\'s commit drops only the calls reported before its new document\'s answer (Firefox reports the new document\'s first call before the commit; a redirect\'s answer is not the document\'s)', async () => {
  for (const redirect of [false, true]) {
    const c = redirect ? 'redirected' : 'answered at once';
    const ctx = fakeContext();
    const inflight = new Inflight(ctx);
    const page = new EventEmitter();
    const frame = { page: () => page };
    ctx.emit('page', page);
    const old = frameRequest(frame, '/slow');
    ctx.emit('request', old);
    const nav = frameRequest(frame, '/next', true);
    ctx.emit('request', nav);
    // The old document's poller fires while the navigation runs.
    const during = frameRequest(frame, '/poll');
    ctx.emit('request', during);
    let final = nav;
    let late = null;
    if (redirect) {
      ctx.emit('response', answer(nav, 302, { location: '/moved' }));
      ctx.emit('requestfinished', nav);
      late = frameRequest(frame, '/poll2');
      ctx.emit('request', late);
      final = frameRequest(frame, '/moved', true);
      ctx.emit('request', final);
    }
    ctx.emit('response', answer(final));
    ctx.emit('requestfinished', final);
    const mine = frameRequest(frame, '/hold.png');
    ctx.emit('request', mine);
    page.emit('framenavigated', frame);
    assert.deepEqual(inflight.describe(), ['GET http://localhost/hold.png'], `${c}: only the new document's call is left in flight`);
    let settled = false;
    inflight.settled().then(() => { settled = true; });
    await ticks();
    assert.equal(settled, false, `${c}: settle waits for the new document's call`);
    // A route change inside the new document (no answer) drops nothing.
    page.emit('framenavigated', frame);
    assert.equal(inflight.size, 1, `${c}: a commit with no answer drops nothing`);
    ctx.emit('requestfinished', mine);
    await ticks();
    assert.equal(settled, true, `${c}: settle is woken once the new document's call ends`);
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
