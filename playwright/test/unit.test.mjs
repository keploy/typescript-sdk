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
import { Inflight, QUIET_MAX_MS, QUIET_MS, busyLine, namedWait } from '../dist/settle.js';
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
  for (let i = 0; i < 20; i++) await Promise.resolve();
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

// quiet(), on a fake context with Node's mock timers: what ends its wait is
// the context's request events and timers set from them; its bound counts
// time with no call in flight on the clock it is given (here the mocked
// Date, which the mocked timers move).
function quietOn(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctx = fakeContext();
  // The browser answers each ask() at once.
  const inflight = new Inflight(ctx, () => Date.now(), () => Promise.resolve());
  const page = new EventEmitter();
  ctx.emit('page', page);
  const res = { value: 'waiting', named: 0 };
  // named(): the step the fixture wraps settled() in.
  const named = () => { res.named++; return inflight.settled(); };
  return { ctx, page, inflight, res, wait: () => { inflight.quiet(QUIET_MS, QUIET_MAX_MS, named).then((q) => { res.value = q; }); } };
}
async function after(t, ms) {
  await ticks();
  t.mock.timers.tick(ms);
  await ticks();
}

test('quiet: the bounds are 500 ms of no call starting or ending, and 3 s with no call in flight', () => {
  assert.equal(QUIET_MS, 500);
  assert.equal(QUIET_MAX_MS, 3000);
  assert.equal(busyLine('t'), 'keploy: t ended with its pages still making calls: they did not go 500 ms without a call starting or ending ' +
    'in 3000 ms with no call in flight, from the start of its browser context\'s teardown, so a call they would have made later is not the test\'s, ' +
    'at record or at replay (each call in flight was waited for to its end).');
});

test('quiet: with no call, the wait ends 500 ms after it began, not before', async (t) => {
  const q = quietOn(t);
  // A call that ended before the wait began does not shorten it.
  const r = fakeRequest(q.page);
  q.ctx.emit('request', r);
  q.ctx.emit('requestfinished', r);
  await after(t, 400);
  q.wait();
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.value, 'waiting');
  await after(t, 1);
  assert.equal(q.res.value, true);
  assert.equal(q.res.named, 0);
});

// A timer that fires says only that this process saw no call for that long:
// a loaded machine can hold its event loop while the browser's events wait
// unread. So the wait asks the browser (context.cookies() by default) and
// ends only once it has answered.
test('quiet: a window or bound that has passed ends the wait only once the browser has answered: a call it reported first keeps the wait going, one that ended restarts the window, and no answer leaves the verdict', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const on = (ask) => {
    const ctx = fakeContext();
    const inflight = new Inflight(ctx, () => Date.now(), ask);
    const page = new EventEmitter();
    ctx.emit('page', page);
    const res = { value: 'waiting' };
    inflight.quiet(QUIET_MS, QUIET_MAX_MS, () => inflight.settled()).then((q) => { res.value = q; });
    return { ctx, page, res };
  };
  const asks = [];
  const ask = () => new Promise((resolve) => asks.push(resolve));
  // The window has passed: the wait ends at the answer, not before.
  let q = on(ask);
  await after(t, QUIET_MS);
  assert.equal(asks.length, 1);
  await after(t, 1000);
  assert.equal(q.res.value, 'waiting');
  asks.shift()();
  await ticks();
  assert.equal(q.res.value, true);
  // A call reported before the answer: the wait goes on, from its end.
  q = on(ask);
  await after(t, QUIET_MS);
  const r = fakeRequest(q.page);
  q.ctx.emit('request', r);
  q.ctx.emit('requestfinished', r);
  asks.shift()();
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.value, 'waiting');
  await after(t, 1);
  asks.shift()();
  await ticks();
  assert.equal(q.res.value, true);
  // The end of a call begun before the wait could see it, reported before
  // the answer, restarts the window.
  q = on(ask);
  await after(t, QUIET_MS);
  q.ctx.emit('requestfailed', fakeRequest(q.page));
  asks.shift()();
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.value, 'waiting');
  await after(t, 1);
  assert.equal(asks.length, 1);
  asks.shift()();
  await ticks();
  assert.equal(q.res.value, true);
  // The bound has passed: a call reported before the answer is waited for,
  // and the wait then ends at the bound; an ended call's report does not
  // move the bound.
  q = on(ask);
  for (let i = 0; i < QUIET_MAX_MS / 100; i++) {
    const c = fakeRequest(q.page);
    q.ctx.emit('request', c);
    q.ctx.emit('requestfinished', c);
    await after(t, 100);
  }
  assert.equal(asks.length, 1);
  const late = fakeRequest(q.page);
  q.ctx.emit('request', late);
  asks.shift()();
  await after(t, 200);
  assert.equal(q.res.value, 'waiting');
  q.ctx.emit('requestfinished', late);
  await after(t, 1);
  q.ctx.emit('requestfailed', fakeRequest(q.page));
  assert.equal(asks.length, 1);
  asks.shift()();
  await ticks();
  assert.equal(q.res.value, false);
  // A browser that cannot answer (its context is closing) leaves the verdict.
  q = on(() => Promise.reject(new Error('Target page, context or browser has been closed')));
  await after(t, QUIET_MS);
  assert.equal(q.res.value, true);
  assert.equal(asks.length, 0);
});

test('quiet: a call that starts restarts the window and holds it while in flight, by name once it has lasted 500 ms; its end, answered or failed, restarts it', async (t) => {
  for (const ending of ['requestfinished', 'requestfailed']) {
    for (const flight of [QUIET_MS - 1, QUIET_MS + 100]) {
      const c = `${ending}, in flight ${flight} ms`;
      const q = quietOn(t);
      q.wait();
      await after(t, 300);
      const r = fakeRequest(q.page);
      q.ctx.emit('request', r);
      // In flight past where the window would have ended, and (the second
      // time) past its own length.
      await after(t, flight);
      assert.equal(q.res.value, 'waiting', c);
      assert.equal(q.res.named, flight < QUIET_MS ? 0 : 1, c);
      q.ctx.emit(ending, r);
      await after(t, QUIET_MS - 1);
      assert.equal(q.res.value, 'waiting', c);
      await after(t, 1);
      assert.equal(q.res.value, true, c);
      assert.equal(q.res.named, flight < QUIET_MS ? 0 : 1, c);
      t.mock.timers.reset();
    }
  }
});

test('quiet: calls in flight one after another, with no break, keep the wait in flight: named once it has lasted 500 ms', async (t) => {
  const q = quietOn(t);
  q.wait();
  let r = fakeRequest(q.page);
  q.ctx.emit('request', r);
  for (let i = 0; i < 4; i++) {
    await after(t, 200);
    const next = fakeRequest(q.page);
    q.ctx.emit('request', next);
    q.ctx.emit('requestfinished', r);
    r = next;
  }
  assert.equal(q.res.named, 1);
  q.ctx.emit('requestfinished', r);
  await after(t, QUIET_MS);
  assert.equal(q.res.value, true);
  assert.equal(q.res.named, 1);
});

// The fixture's named wait (namedWait), with a step that, as Playwright's
// may, lets a call start before it runs its body.
test('quiet: a named wait is a step that names the calls in flight, five at most, and waits for those, not for a call that starts before the step runs its body', async () => {
  for (const n of [1, 5, 6]) {
    const ctx = fakeContext();
    const inflight = new Inflight(ctx);
    const page = new EventEmitter();
    ctx.emit('page', page);
    const req = (i) => ({ ...fakeRequest(page), url: () => `http://localhost/c${i}` });
    const calls = Array.from({ length: n }, (_, i) => req(i + 1));
    calls.forEach((r) => ctx.emit('request', r));
    const late = req(0);
    const titles = [];
    let ended = false;
    const step = async (title, body) => { titles.push(title); ctx.emit('request', late); await ticks(); return body(); };
    namedWait(inflight, step)().then(() => { ended = true; });
    await ticks();
    const shown = calls.slice(0, 5).map((r) => `GET ${r.url()}`).join(', ') + (n > 5 ? `, and ${n - 5} more` : '');
    assert.deepEqual(titles, [`keploy: wait for the test's ${n} call(s) in flight before its browser context closes: ${shown}`], `${n} calls`);
    assert.equal(ended, false, `${n} calls: the wait waits for the calls it names`);
    calls.forEach((r) => ctx.emit('requestfinished', r));
    await ticks();
    assert.equal(ended, true, `${n} calls: the wait ends once they have ended, the later call still in flight`);
    assert.deepEqual(inflight.inFlight(), [late], `${n} calls`);
  }
});

test('quiet: a named wait waits for the calls it names; a call begun during it, still in flight after them, is named in a wait of its own', async (t) => {
  const q = quietOn(t);
  q.wait();
  const first = fakeRequest(q.page);
  q.ctx.emit('request', first);
  await after(t, QUIET_MS);
  assert.equal(q.res.named, 1);
  const later = fakeRequest(q.page);
  q.ctx.emit('request', later);
  await after(t, 500);
  q.ctx.emit('requestfinished', first);
  // A wait for calls that have all ended ends at once, with another in flight.
  let done = false;
  q.inflight.settled([first]).then(() => { done = true; });
  await ticks();
  assert.equal(done, true);
  // The first wait has ended; the later call is in flight on its own.
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.named, 1);
  await after(t, 1);
  assert.equal(q.res.named, 2);
  assert.deepEqual(q.inflight.inFlight(), [later]);
  q.ctx.emit('requestfinished', later);
  await after(t, QUIET_MS);
  assert.equal(q.res.value, true);
  assert.equal(q.res.named, 2);
});

test('quiet: a call that starts while the window runs, with none in flight, restarts it from its start', async (t) => {
  const q = quietOn(t);
  q.wait();
  await after(t, 400);
  const r = fakeRequest(q.page);
  q.ctx.emit('request', r);
  q.ctx.emit('requestfinished', r);
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.value, 'waiting');
  await after(t, 1);
  assert.equal(q.res.value, true);
});

test('quiet: the end of a call it does not count (dropped as cancelled, or begun before it watched) restarts the window too', async (t) => {
  for (const which of ['dropped', 'unseen']) {
    const q = quietOn(t);
    const other = new EventEmitter();
    q.ctx.emit('page', other);
    const r = fakeRequest(which === 'dropped' ? other : q.page);
    if (which === 'dropped') {
      q.ctx.emit('request', r);
      other.emit('close');
      assert.equal(q.inflight.size, 0, which);
    }
    q.wait();
    await after(t, 400);
    // The browser reports an end for it after all.
    q.ctx.emit('requestfailed', r);
    await after(t, QUIET_MS - 1);
    assert.equal(q.res.value, 'waiting', which);
    await after(t, 1);
    assert.equal(q.res.value, true, which);
    t.mock.timers.reset();
  }
});

test('quiet: a call its page\'s close cancels ends, and restarts the window, named or not yet; a page that closes with no call in flight ends none', async (t) => {
  let q = quietOn(t);
  const other = new EventEmitter();
  q.ctx.emit('page', other);
  q.wait();
  await after(t, 400);
  other.emit('close');
  await after(t, QUIET_MS - 400);
  assert.equal(q.res.value, true, 'a close that cancels nothing leaves the window as it ran');
  t.mock.timers.reset();
  q = quietOn(t);
  q.ctx.emit('request', fakeRequest(q.page));
  q.wait();
  await after(t, QUIET_MS);
  assert.equal(q.res.value, 'waiting');
  assert.equal(q.res.named, 1);
  q.page.emit('close');
  assert.equal(q.inflight.size, 0);
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.value, 'waiting');
  await after(t, 1);
  assert.equal(q.res.value, true);
  t.mock.timers.reset();
  // Cancelled 200 ms into its flight: the wait for it ends at the close,
  // unnamed, and the window runs from the close.
  q = quietOn(t);
  q.ctx.emit('request', fakeRequest(q.page));
  q.wait();
  await after(t, 200);
  q.page.emit('close');
  assert.equal(q.inflight.size, 0);
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.value, 'waiting');
  assert.equal(q.res.named, 0);
  await after(t, 1);
  assert.equal(q.res.value, true);
  assert.equal(q.res.named, 0);
});

test('quiet: pages that never go quiet end the wait after 3 s with no call in flight, not before, answering that they did not go quiet', async (t) => {
  const q = quietOn(t);
  q.wait();
  for (let at = 0; at < QUIET_MAX_MS - 100; at += 100) {
    const r = fakeRequest(q.page);
    q.ctx.emit('request', r);
    q.ctx.emit('requestfinished', r);
    await after(t, 100);
  }
  await after(t, 99);
  assert.equal(q.res.value, 'waiting');
  await after(t, 1);
  assert.equal(q.res.value, false);
  assert.equal(q.res.named, 0);
});

// The default clock, with real timers and the process's Date held (mocked,
// never moved): a page that calls every 10 ms, each call answered at once,
// never goes 200 ms without a call, and the 300 ms bound still comes. A
// stall of the process runs the page's timer before the window's, as the
// earlier one, so no stall ends the wait as quiet.
test('quiet: the bound is measured on the process\'s monotonic clock, so a held Date does not hold it', { timeout: 20000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const ctx = fakeContext();
  const inflight = new Inflight(ctx);
  const page = new EventEmitter();
  ctx.emit('page', page);
  const poll = setInterval(() => { const r = fakeRequest(page); ctx.emit('request', r); ctx.emit('requestfinished', r); }, 10);
  // A wait that never ends is this row's failure, not a hang of the file: the
  // page's calls stop either way, and a wait still running stops at its next
  // named wait, which never ends (this page has no call in flight for 200 ms,
  // so a right wait is never named).
  let hung;
  let stopped = false;
  let named = 0;
  try {
    const ended = await Promise.race([
      inflight.quiet(200, 300, () => { named++; return stopped ? new Promise(() => {}) : inflight.settled(); }),
      new Promise((resolve) => { hung = setTimeout(() => resolve('still waiting after 10 s'), 10000); }),
    ]);
    assert.equal(ended, false);
    assert.equal(named, 0);
  } finally {
    stopped = true;
    clearInterval(poll);
    clearTimeout(hung);
  }
});

test('quiet: time a call is in flight counts toward no bound, short or long, so a slow answer and a quick one end the wait alike', async (t) => {
  for (const flight of [400, 5000]) {
    const q = quietOn(t);
    q.wait();
    // 1 s with no call in flight, then one call in flight for flight ms.
    for (let at = 0; at < 1000; at += 100) {
      const r = fakeRequest(q.page);
      q.ctx.emit('request', r);
      q.ctx.emit('requestfinished', r);
      await after(t, 100);
    }
    const slow = fakeRequest(q.page);
    q.ctx.emit('request', slow);
    await after(t, flight);
    q.ctx.emit('requestfinished', slow);
    // Then a call every 100 ms, each ended at once: the other 2 s with no
    // call in flight end the wait.
    for (let at = 0; at < QUIET_MAX_MS - 1000 - 100; at += 100) {
      const r = fakeRequest(q.page);
      q.ctx.emit('request', r);
      q.ctx.emit('requestfinished', r);
      await after(t, 100);
    }
    await after(t, 99);
    assert.equal(q.res.value, 'waiting', `in flight ${flight} ms`);
    await after(t, 1);
    assert.equal(q.res.value, false, `in flight ${flight} ms`);
    assert.equal(q.res.named, flight < QUIET_MS ? 0 : 1, `in flight ${flight} ms`);
    t.mock.timers.reset();
  }
});

test('quiet: a call that never ends keeps the wait named, past any bound, until the test\'s timeout', async (t) => {
  const q = quietOn(t);
  q.wait();
  q.ctx.emit('request', fakeRequest(q.page));
  await after(t, QUIET_MS - 1);
  assert.equal(q.res.named, 0);
  await after(t, 1);
  assert.equal(q.res.named, 1);
  for (let at = 0; at < 4 * QUIET_MAX_MS; at += 100) {
    // A poller beside it: its calls start and end.
    const r = fakeRequest(q.page);
    q.ctx.emit('request', r);
    q.ctx.emit('requestfinished', r);
    await after(t, 100);
  }
  assert.equal(q.res.value, 'waiting');
  assert.equal(q.res.named, 1);
});

// The timers set while it is installed that have neither run nor been
// cleared.
function pendingTimers() {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Set();
  const made = { n: 0 };
  const cleared = { n: 0 };
  globalThis.setTimeout = (f, ms, ...a) => {
    made.n++;
    const id = set(() => { pending.delete(id); f(...a); }, ms);
    pending.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => { cleared.n++; pending.delete(id); clear(id); };
  return { pending, made, cleared, restore: () => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; } };
}

test('quiet: once the wait has ended, quiet, after a named wait or at the bound, it leaves no timer of its own running and keeps none of its waits, and the context\'s calls set or clear no timer', async (t) => {
  for (const ending of ['quiet', 'named', 'bound']) {
    const q = quietOn(t);
    const timers = pendingTimers();
    try {
      q.wait();
      if (ending === 'bound') {
        // A call every 400 ms, each in flight 50 ms: the window is running,
        // 350 ms after a call was last in flight, when the bound comes: once
        // the 350 ms gaps add up to 3000 ms, after about nine calls. The calls
        // stop after 9 s; a wait still running then fails the assert below.
        for (let at = 0; q.res.value === 'waiting' && at < 3 * QUIET_MAX_MS; at += 400) {
          const r = fakeRequest(q.page);
          q.ctx.emit('request', r);
          await after(t, 50);
          q.ctx.emit('requestfinished', r);
          await after(t, 350);
        }
      } else if (ending === 'named') {
        const r = fakeRequest(q.page);
        q.ctx.emit('request', r);
        await after(t, QUIET_MS + 100);
        assert.equal(q.res.named, 1);
        q.ctx.emit('requestfinished', r);
        await after(t, QUIET_MS);
      } else await after(t, QUIET_MS);
      assert.equal(q.res.value, ending !== 'bound', ending);
      assert.equal(timers.pending.size, 0, ending);
      // The Inflight lives as long as the context: a wait that has ended
      // keeps nothing in it (settled()'s waits are its own state; no event
      // shows them).
      assert.deepEqual(q.inflight.waiters, [], ending);
      const made = timers.made.n;
      const cleared = timers.cleared.n;
      const r = fakeRequest(q.page);
      q.ctx.emit('request', r);
      q.ctx.emit('requestfinished', r);
      // Nothing of the wait still listens: a call neither sets a timer nor
      // clears one.
      assert.equal(timers.made.n, made, ending);
      assert.equal(timers.cleared.n, cleared, ending);
    } finally { timers.restore(); }
    t.mock.timers.reset();
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
