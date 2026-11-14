// Unit rows for a test's note (note.ts) and the agent client's note fields,
// against a fake agent. No browser: the browser rows are in rows.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AgentClient, KeployError, MAX_NOTE } from '../dist/agent.js';
import { MAX_DOCS, MAX_LINES, NO_NOTE_LINE, differences, docLog, keepDocDraws, noteText, readNote, unreadNoteLine } from '../dist/note.js';
import { seatFaker, setAside, seatRandom, tally } from '../dist/random.js';

async function agent(answer) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const call = { path: req.url, body: body ? JSON.parse(body) : null };
      calls.push(call);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(call)));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}

const note = (p = {}, d = {}, cut = 0) => ({ v: 1, p, d, cut });
const doc = (at, n = [0, 0, 0], f = {}) => ({ at, n, f });

test('note: tally counts each draw under its name and gives the draw\'s number', () => {
  const counts = new Map();
  let i = 0;
  const a = tally(counts, 'a', () => ++i / 10);
  const b = tally(counts, 'b', () => 0.5);
  assert.deepEqual([a(), a(), b()], [0.1, 0.2, 0.5]);
  assert.deepEqual([...counts], [['a', 2], ['b', 1]]);
});

test('note: a document\'s reports keep the larger of each count and its first address; a report that is no document\'s draws is not kept', () => {
  const log = docLog();
  keepDocDraws(log, 'k', 'http://h/p', [1, 0, 2], { '/f': 1 });
  keepDocDraws(log, 'k', 'http://h/other', [3, 0, 1], { '/f': 0, '/g': 2 });
  assert.deepEqual([...log.docs], [['k', { at: 'http://h/p', n: [3, 0, 2], f: { '/f': 1, '/g': 2 } }]]);
  // Each of these is dropped whole.
  for (const [key, n, f] of [
    [1, [0, 0, 0], {}], ['', [0, 0, 0], {}], ['x', [0, 0], {}], ['x', [0, 0, 0, 0], {}], ['x', 'abc', {}],
    ['x', [0, -1, 0], {}], ['x', [0, 1.5, 0], {}], ['x', [0, '1', 0], {}], ['x', [0, 2 ** 53, 0], {}],
    ['x', [0, 0, 0], null], ['x', [0, 0, 0], []], ['x', [0, 0, 0], 'f'], ['x', [0, 0, 0], { '/f': -1 }], ['x', [0, 0, 0], { '/f': 'one' }],
  ]) keepDocDraws(log, key, 'http://h/x', n, f);
  assert.deepEqual([...log.docs.keys()], ['k']);
  assert.equal(log.dropped.size, 0);
  // An address is kept as the run's output shows one: one line.
  keepDocDraws(log, 'nl', 'http://h/a\nb', [0, 0, 0], {});
  assert.equal(log.docs.get('nl').at, 'http://h/a?b');
});

test('note: past MAX_DOCS documents a new one is not kept but counted as cut; a kept one still takes its reports', () => {
  const log = docLog();
  for (let i = 0; i < MAX_DOCS; i++) keepDocDraws(log, `k${i}`, 'http://h/p', [1, 0, 0], {});
  keepDocDraws(log, 'new', 'http://h/p', [1, 0, 0], {});
  keepDocDraws(log, 'new', 'http://h/p', [2, 0, 0], {});
  keepDocDraws(log, 'newer', 'http://h/p', [1, 0, 0], {});
  keepDocDraws(log, 'k0', 'http://h/p', [5, 0, 0], {});
  assert.equal(log.docs.size, MAX_DOCS);
  assert.equal(log.docs.has('new'), false);
  assert.deepEqual(log.docs.get('k0').n, [5, 0, 0]);
  assert.deepEqual([...log.dropped], ['new', 'newer']);
  const n = readNote(noteText(new Map(), log));
  assert.equal(typeof n, 'object');
  assert.ok(n.cut >= 2, String(n.cut));
});

test('note: the note is JSON of at most MAX_NOTE UTF-8 bytes, cutting the last documents and counting them', () => {
  const small = docLog();
  keepDocDraws(small, 'a', 'http://h/a', [1, 2, 3], { '/f': 1 });
  const p = new Map([['Math.random', 4]]);
  assert.deepEqual(JSON.parse(noteText(p, small)), { v: 1, p: { 'Math.random': 4 }, d: { a: { at: 'http://h/a', n: [1, 2, 3], f: { '/f': 1 } } }, cut: 0 });
  // Documents of multi-byte addresses: the bound is in bytes, not characters.
  const big = docLog();
  for (let i = 0; i < 400; i++) keepDocDraws(big, `doc ${i}`, `http://h/${'é'.repeat(40)}${i}`, [i, 0, 0], {});
  const text = noteText(p, big);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_NOTE, String(Buffer.byteLength(text, 'utf8')));
  const n = JSON.parse(text);
  const kept = Object.keys(n.d);
  assert.ok(kept.length > 0 && kept.length < 400, String(kept.length));
  // The first ones are kept, in order; the rest are counted as cut.
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, i) => `doc ${i}`));
  assert.equal(n.cut, 400 - kept.length);
  // One document more would take it past the bound.
  const one = docLog();
  for (let i = 0; i <= kept.length; i++) keepDocDraws(one, `doc ${i}`, `http://h/${'é'.repeat(40)}${i}`, [i, 0, 0], {});
  one.docs.delete(`doc ${kept.length}`);
  assert.equal(noteText(p, one), JSON.stringify({ ...n, cut: 0 }));
});

test('note: a note of exactly MAX_NOTE bytes is kept whole; past it, once no document is left, the streams are cut, the last first, and counted', () => {
  // The bound is met through the key's length (an address is cut at 512).
  const one = (a) => { const log = docLog(); keepDocDraws(log, `k${a}`, 'http://h/a', [0, 0, 0], {}); return log; };
  const base = Buffer.byteLength(noteText(new Map(), one('')), 'utf8');
  const exact = noteText(new Map(), one('a'.repeat(MAX_NOTE - base)));
  assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_NOTE);
  assert.equal(JSON.parse(exact).cut, 0);
  assert.equal(Object.keys(JSON.parse(exact).d).length, 1);
  const over = JSON.parse(noteText(new Map(), one('a'.repeat(MAX_NOTE - base + 1))));
  assert.deepEqual([over.d, over.cut], [{}, 1]);
  // A suite's own faker instance under a long name: streams go once no
  // document is left, the last drawn first.
  const long = '@faker-js/faker own ' + 'x'.repeat(MAX_NOTE);
  const p = new Map([['Math.random', 2], [long, 1], ['late', 3]]);
  const n = JSON.parse(noteText(p, one('http://h/a')));
  assert.deepEqual(n, { v: 1, p: { 'Math.random': 2 }, d: {}, cut: 3 });
  const huge = JSON.parse(noteText(new Map([[long, 1]]), docLog()));
  assert.deepEqual(huge, { v: 1, p: {}, d: {}, cut: 1 });
});

test('note: the test process counts the draws of each faker instance seated with counts under its stream, not those set aside; without counts it counts none', () => {
  const r = { next: () => 0.25, seed: () => undefined };
  const counts = new Map();
  const unseatR = seatRandom(() => 0.5);
  const unseat = seatFaker('0123abcd', [['faker', r]], counts);
  r.next(); r.next();
  const put = setAside();
  assert.equal(r.next(), 0.25);
  put();
  unseat(); unseatR();
  assert.deepEqual([...counts], [['@faker-js/faker faker', 2]]);
  const r2 = { next: () => 0.25, seed: () => undefined };
  const unseat2 = seatFaker('0123abcd', [['faker', r2]]);
  assert.notEqual(r2.next(), 0.25);
  unseat2();
});

test('note: readNote reads this package\'s note and says why it cannot read another', () => {
  const good = note({ 'Math.random': 1 }, { k: doc('http://h/p', [1, 0, 0], { '/f': 2 }) }, 3);
  assert.deepEqual(readNote(JSON.stringify(good)), good);
  for (const [text, why] of [
    ['{', 'it is not JSON'],
    ['[1]', 'it is not an object'],
    ['null', 'it is not an object'],
    ['"x"', 'it is not an object'],
    [JSON.stringify({ ...good, v: 2 }), 'it is version 2, and this @keploy/playwright reads version 1'],
    [JSON.stringify({ p: {}, d: {}, cut: 0 }), 'it is version null, and this @keploy/playwright reads version 1'],
    [JSON.stringify({ ...good, p: null }), 'its test process counts are not counts'],
    [JSON.stringify({ ...good, p: [1] }), 'its test process counts are not counts'],
    [JSON.stringify({ ...good, p: { a: -1 } }), 'its test process counts are not counts'],
    [JSON.stringify({ ...good, d: null }), 'its documents are not an object'],
    [JSON.stringify({ ...good, d: [] }), 'its documents are not an object'],
    [JSON.stringify({ ...good, d: { k: null } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, d: { k: { ...doc('x'), at: 1 } } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, d: { k: doc('x', [0, 0]) } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, d: { k: doc('x', [0, 0, -1]) } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, d: { k: doc('x', 'abc') } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, d: { k: doc('x', [0, 0, 0], null) } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, d: { k: doc('x', [0, 0, 0], []) } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, d: { k: doc('x', [0, 0, 0], { '/f': 0.5 }) } }), 'a document\'s counts are not counts'],
    [JSON.stringify({ ...good, cut: -1 }), 'its cut is not a count'],
    [JSON.stringify({ v: 1, p: {}, d: {} }), 'its cut is not a count'],
  ]) assert.equal(readNote(text), why, text);
  assert.equal(unreadNoteLine('t', 'it is not JSON'), 'keploy: the note keploy kept of how t\'s recording drew cannot be read (it is not JSON), ' +
    'so where its replay draws otherwise, no line names it: record the test again with this @keploy/playwright.');
});

test('note: a replay that draws as its recording did has no difference; each stream, function and path that differs has one line', () => {
  const rec = note({ 'Math.random': 3, '@faker-js/faker faker': 2 }, { a: doc('http://h/a', [2, 1, 1], { '/f': 1, '/g': 2 }), b: doc('http://h/b', [1, 0, 0]) });
  assert.deepEqual(differences('t', rec, rec), []);
  const now = note({ 'Math.random': 1, 'other': 1 }, { a: doc('http://h/a2', [2, 0, 3], { '/f': 2 }), c: doc('http://h/c', [0, 0, 1]) });
  const lines = differences('t', rec, now);
  assert.deepEqual(lines.map((l) => l.split(', so ')[0]), [
    'keploy: t drew Math.random once in the test process at this replay and 3 times in its recording',
    'keploy: t drew @faker-js/faker faker 0 times in the test process at this replay and 2 times in its recording',
    'keploy: t drew other once in the test process at this replay and 0 times in its recording',
    'keploy: t: the document at http://h/a2 drew crypto.getRandomValues 0 times at this replay and once in its recording',
    'keploy: t: the document at http://h/a2 drew crypto.randomUUID 3 times at this replay and once in its recording',
    'keploy: t: the document at http://h/a2 put in 2 frame(s) at /f at this replay and 1 in its recording',
    'keploy: t: the document at http://h/a2 put in 0 frame(s) at /g at this replay and 2 in its recording',
    'keploy: t: the document at http://h/b drew Math.random 0 times at this replay and once in its recording',
    'keploy: t drew otherwise than its recording in 1 more way(s) than the lines above name.',
  ]);
  assert.equal(lines.length, MAX_LINES + 1);
  // Each line names its next step.
  assert.match(lines[0], /, so its draws from that stream after the first one that differs are not the recording's, .*register a worker fixture with this package's test\.extend.*\.$/);
  assert.match(lines[3], /, so its draws of that function after the first one that differs are not the recording's: .*give each frame its own path\.$/);
  assert.match(lines[5], /, so the frames at that path may take other places than in the recording and draw other numbers: give each frame at that path its own src path, or put them in in a fixed order and number\.$/);
  // At most MAX_LINES: exactly that many are all said.
  const eight = differences('t', note({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1 }), note());
  assert.equal(eight.length, MAX_LINES);
  assert.ok(!eight.some((l) => l.includes('more way(s)')));
  // A path that is no one line is shown as one.
  assert.match(differences('t', note({}, { a: doc('h', [0, 0, 0], { 'x\ny': 1 }) }), note({}, { a: doc('h') }))[0], / at x\?y at this replay/);
});

test('note: a document one note cut is compared with nothing', () => {
  const rec = note({}, { a: doc('http://h/a', [1, 0, 0]) }, 1);
  const now = note({}, { a: doc('http://h/a', [1, 0, 0]), b: doc('http://h/b', [4, 0, 0]) });
  assert.deepEqual(differences('t', rec, now), []);
  assert.equal(differences('t', { ...rec, cut: 0 }, now).length, 1);
  // A stream one note cut is compared with nothing too.
  assert.deepEqual(differences('t', note({ 'Math.random': 1 }, {}, 1), note({ 'Math.random': 1, s: 2 })), []);
  assert.deepEqual(differences('t', note({ 'Math.random': 1, s: 2 }), note({ 'Math.random': 1 }, {}, 1)), []);
  assert.equal(differences('t', note({ 'Math.random': 1, s: 2 }), note({ 'Math.random': 1 })).length, 1);
  const cutNow = note({}, {}, 1);
  assert.deepEqual(differences('t', note({}, { a: doc('http://h/a', [1, 0, 0]) }), cutNow), []);
  assert.equal(differences('t', note({}, { a: doc('http://h/a', [1, 0, 0]) }), note()).length, 1);
});

test('note: the no-note line names what keeps none and the next step', () => {
  assert.match(NO_NOTE_LINE, /^keploy: keploy answered a seeded replay's begin with no note .*keploy v3\.7\.5 or older.*@keploy\/playwright 0\.1\.1 or older.*Record the tests again with a keploy that keeps notes/);
});

test('the client: a begin\'s answer gives the note keploy answered; one that is no note keploy keeps fails the test; an end sends a note it is given', async () => {
  const atBound = 'n'.repeat(MAX_NOTE - 2) + 'é';
  for (const [body, want] of [[{ v: 1, status: 'ok', note: '{"v":1}' }, '{"v":1}'], [{ v: 1, status: 'ok', note: '' }, ''], [{ v: 1, status: 'ok' }, undefined], [{ v: 1, status: 'ok', note: atBound }, atBound]]) {
    const a = await agent(() => body);
    try {
      assert.equal((await new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' }, 'seeded', 'ffffffff')).note, want);
    } finally { await a.close(); }
  }
  for (const [note, re] of [
    [12, /^keploy: the keploy agent answered the begin of a with the note "12", which is no note keploy keeps \(a string of at most 16384 bytes\)$/],
    [null, /with the note "null", which is no note/],
    [{ v: 1 }, /with the note "\{\\"v\\":1\}", which is no note/],
    ['n'.repeat(MAX_NOTE - 1) + 'é', /^keploy: the keploy agent answered the begin of a with the note "n{512}"\.\.\., which is no note keploy keeps/],
  ]) {
    const a = await agent(() => ({ v: 1, status: 'ok', note }));
    try {
      await assert.rejects(new AgentClient(a.url, '').begin({ name: 'a', file: 'a.spec.ts' }, 'seeded', 'ffffffff'), (err) => {
        assert.ok(err instanceof KeployError, String(err));
        assert.match(err.message, re);
        return true;
      });
    } finally { await a.close(); }
  }
  const a = await agent(() => ({ v: 1, status: 'ok' }));
  try {
    const c = new AgentClient(a.url, '');
    await c.end({ name: 'a', file: 'a.spec.ts' }, 'passed', 'seeded', '{"v":1}');
    await c.end({ name: 'b', file: 'a.spec.ts' }, 'passed', 'seeded', '');
    await c.end({ name: 'c', file: 'a.spec.ts' }, 'passed');
    assert.deepEqual(a.calls.map((x) => x.body), [
      { name: 'a', file: 'a.spec.ts', outcome: 'passed', random: 'seeded', note: '{"v":1}' },
      { name: 'b', file: 'a.spec.ts', outcome: 'passed', random: 'seeded' },
      { name: 'c', file: 'a.spec.ts', outcome: 'passed' },
    ]);
  } finally { await a.close(); }
});
