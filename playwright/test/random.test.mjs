// Unit rows of the seeding: the env rule, the seed, the test process's
// stream, and the browser's init script run in a Node vm context in place of
// a page. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_KEY, ENV_SEED_RANDOM, FAKER, LOADS_KEY, OFF_LINE, PAGE_KEY, SEEDED_LINE, esmFile, exportOf, fakerLine, fakersIn, fakersOf, firstScript, freshSeed, initScript, besideOf, othersNow, pageAddress, pageScript, placePages, processRandom, seatFaker, seatRandom, seedFaker, seedingFromEnv, setAside, unplacedLine, unseededLine, WORKER_PARAM, SW_CHANNEL, SW_LOCK, markWorker, useStrict, withBytes, oneLine, lateLine, redirectLine, STOPPED, workerMark, workerScript, workerRoutes, workerAnswer, cspAllowsData } from '../dist/random.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from '../dist/agent.js';
import { OTHER, documentAt, workerAt } from './draws.mjs';

// Two seeds, as keploy answers them.
const S1 = '0123456789abcdef0123456789abcdef';
const S2 = 'fedcba9876543210fedcba9876543210';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('seeding is on unless KEPLOY_SEED_RANDOM turns it off; another value is refused, naming it', () => {
  for (const v of [undefined, '', 'on', 'ON', '1', 'true', ' on ']) {
    assert.deepEqual(seedingFromEnv({ [ENV_SEED_RANDOM]: v }), { mode: 'seeded' }, String(v));
  }
  for (const v of ['off', 'OFF', 'Off', '0', 'false', ' off ']) {
    assert.deepEqual(seedingFromEnv({ [ENV_SEED_RANDOM]: v }), { mode: 'off' }, v);
  }
  for (const v of ['yes', 'no', 'seeded', '2']) {
    const s = seedingFromEnv({ [ENV_SEED_RANDOM]: v });
    assert.equal(s.mode, 'refused', v);
    assert.equal(s.refusal, `keploy: KEPLOY_SEED_RANDOM=${JSON.stringify(v)} is neither on nor off; set it to off to give the test browser and the test process their own random numbers, or unset it to seed them per test`);
  }
});

test('the lines say what is seeded, what is not, where the seed lives, and how to turn it off or on', () => {
  assert.equal(SEEDED_LINE, 'keploy: each test\'s random numbers are seeded from a seed keploy keeps with the test\'s recording, so a replay draws the numbers its recording drew: ' +
    'in the test browser Math.random, crypto.getRandomValues and crypto.randomUUID, in its pages and the Web Workers and Shared Workers they start, ' +
    'and in the test process Math.random and the instances ' +
    '@faker-js/faker makes as it loads (faker, fakerDE, ...), from the test\'s begin to its end ' +
    '(its beforeEach and afterEach hooks too). ' +
    'A Service Worker, a page the app opens and a worker that keploy cannot place or reach keep the browser\'s own (each one is named); ' +
    'the test process keeps its own crypto, and its own Math.random and faker outside every test (beforeAll, afterAll, a file as it loads) ' +
    'and while a worker fixture registered with this package\'s test.extend or test.use is set up. ' +
    'Own Faker instances, those the suite makes itself as a file loads (new Faker(...)), draw their own: seed them with seedFaker(instance, name) ' +
    'from this package. An instance the test seeds itself (faker.seed(n)) draws as seeded. ' +
    'To turn it off, record and replay with KEPLOY_SEED_RANDOM=off, or set use: { keploySeedRandom: false } in the Playwright config.');
  assert.equal(OFF_LINE, 'keploy: random numbers are not seeded (KEPLOY_SEED_RANDOM=off, or keploySeedRandom: false), ' +
    'so the test process and the test browser draw their own each run: data a test makes from them (a name, an email, an ID) differs from its recording\'s ' +
    'while a mocked dependency answers with the recording\'s, so a test that checks one against the other fails or is set aside, ' +
    'and a page script\'s random choice may make calls the recording never saw. ' +
    'Unset KEPLOY_SEED_RANDOM and keploySeedRandom to seed them per test.');
  assert.equal(unseededLine('g › t'), 'keploy: keploy answered the begin of g › t with no seed, so its browser and its test process draw their own random numbers: ' +
    'its recording kept none (it was recorded before keploy kept seeds, or with seeding off: record the test again with seeding on, the default, to seed it), ' +
    'or the test was pulled from a Keploy branch, which keeps no seed, or this keploy predates seeds.');
  assert.equal(unplacedLine('g › t', 'http://h/p'), 'keploy: in g › t, the document at http://h/p drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is in a page the app opened that keploy cannot place in the test\'s order (a popup opened with noopener, as a link with target=_blank opens one, ' +
    'or at another origin than its opener\'s page, or after that page moved on, or by a document keploy could not place; or a frame of another origin in one).');
  assert.equal(unplacedLine('g › t', 'http://h/p', 'popup'), unplacedLine('g › t', 'http://h/p'));
  assert.equal(unplacedLine('g › t', 'about:blank', 'own'), 'keploy: in g › t, the document at about:blank drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is in a page the test opened, and it drew before keploy named that page: a script the test added with context.addInitScript ' +
    'runs in each of the page\'s documents before keploy\'s, and so does a draw the test makes there before newPage returns.');
  const uncounted = (beside) => 'keploy: in g › t, the document at http://h/f drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is a frame under a parent of another origin with no session storage (a sandboxed frame without allow-same-origin), or a frame inside one: ' +
    `keploy cannot count the documents that frame loads, so seeded, the next document there (a reload, or a frame the app puts in again at its place)${beside} could draw the same numbers.`;
  assert.equal(unplacedLine('g › t', 'http://h/f', 'uncounted', 3), uncounted(' or, at its path, one of the 3 other frame(s) beside that frame'));
  assert.equal(unplacedLine('g › t', 'http://h/f', 'uncounted', 1), uncounted(' or, at its path, one of the 1 other frame(s) beside that frame'));
  // With no other frame beside it, or a count that is no whole number above
  // 0, the line names no other frame; a count is cut to a whole number.
  for (const n of [0, NaN, -3, undefined, 0.5]) assert.equal(unplacedLine('g › t', 'http://h/f', 'uncounted', n), uncounted(''), String(n));
  assert.equal(unplacedLine('g › t', 'http://h/f', 'uncounted'), uncounted(''));
  assert.equal(unplacedLine('g › t', 'http://h/f', 'uncounted', 2.5), uncounted(' or, at its path, one of the 2 other frame(s) beside that frame'));
  assert.equal(unplacedLine('g › t', 'about:blank', 'frame'), 'keploy: in g › t, the document at about:blank drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is a frame keploy cannot place among its parent\'s frames (one in a closed shadow root or in an object or embed element, ' +
    'which its parent document cannot list, or one whose document began after its removal), or a frame inside one.');
  assert.equal(unplacedLine('g › t', 'about:blank', 'nostorage', 3), 'keploy: in g › t, the document at about:blank drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is a top document with no session storage that keploy can keep its count in (a document of an opaque origin has none: an about:blank loaded after ' +
    'its page\'s first document, a data: URL, a page served with a CSP sandbox without allow-same-origin, or a popup that a page\'s first document opened; ' +
    'or the app has filled it), or a frame of its origin inside one: keploy cannot count the documents loaded at its path in the tab, so seeded, ' +
    'the next one there (a reload, or another visit to that path) could draw the same numbers.');
});

test('an address a page sends is shown on one line, each control character a ?, cut to 512 characters', () => {
  assert.equal(pageAddress('http://h/p'), 'http://h/p');
  assert.equal(pageAddress('http://h/a\nkeploy: forged\r\u0000\u001f\u007f\tz'), 'http://h/a?keploy: forged?????z');
  assert.equal(pageAddress(`http://h/${'x'.repeat(600)}`), `http://h/${'x'.repeat(503)}`);
  assert.equal(pageAddress(42), '42');
});

// A frame of the fixture's frame tree: its parent, its child frames, and
// whether it is detached.
function fakeFrame(parent = null) {
  const f = { kids: [], detached: false, parentFrame: () => parent, childFrames: () => f.kids.slice(), isDetached: () => f.detached };
  if (parent !== null) parent.kids.push(f);
  return f;
}

test('an uncounted frame\'s line counts the frames beside the frame with no session storage, under its parent; none when it is gone or has no parent', () => {
  // Its own frame (0 up), one inside it (1 up), two down (2 up).
  const p = fakeFrame();
  const u = fakeFrame(p);
  for (let i = 0; i < 3; i++) fakeFrame(p);
  const inner = fakeFrame(u);
  fakeFrame(u);
  const deep = fakeFrame(inner);
  assert.deepEqual(besideOf(u, 0), [u, p]);
  assert.deepEqual(besideOf(inner, 1), [u, p]);
  assert.deepEqual(besideOf(deep, 2), [u, p]);
  assert.deepEqual(besideOf(inner, 0), [inner, u]);
  assert.equal(othersNow(besideOf(inner, 1)), 3);
  assert.equal(othersNow(besideOf(inner, 0)), 1);
  // Counted when asked: a frame put in since counts.
  const b = besideOf(u, 0);
  fakeFrame(p);
  assert.equal(othersNow(b), 4);
  // A lone frame: none beside it.
  const lone = fakeFrame();
  assert.equal(othersNow(besideOf(fakeFrame(lone), 0)), 0);
  // Gone (its parent moved on, or the app took it out): none, whatever its
  // parent holds now.
  u.detached = true;
  assert.equal(othersNow(b), 0);
  // A top document, or a frame further up than the top: no parent, and
  // none beside it.
  assert.equal(besideOf(p, 0), null);
  assert.equal(besideOf(u, 1), null);
  assert.equal(besideOf(u, 5), null);
  assert.equal(othersNow(null), 0);
  // What no script of keploy's sends (not a count of frames up): its own.
  for (const bad of [NaN, -1, undefined]) assert.deepEqual(besideOf(inner, bad), [inner, u], String(bad));
});

test('a begin\'s seed is drawn afresh each time: 128 bits of hex, a seed keploy keeps', () => {
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const s = freshSeed();
    assert.match(s, /^[0-9a-f]{32}$/);
    assert.match(s, SEED);
    seen.add(s);
  }
  assert.equal(seen.size, 64);
  // keploy keeps 8 to 64 lower-case hex digits, as it answers them.
  for (const s of ['0123abcd', 'f'.repeat(64)]) assert.match(s, SEED, s);
  for (const s of ['', '0123abc', 'f'.repeat(65), '0123ABCD', '0123abcg', ' 0123abcd']) assert.doesNotMatch(s, SEED, s);
});

test('the test process\'s stream: the same numbers for a seed on every run and every version, others for another seed, 53 bits in [0, 1)', () => {
  // Pinned to a reference made outside this package (sfc32 over the SHA-256
  // of the seed and the stream's name): a recording keeps the seed, not the
  // numbers, so a change here would make every recording's data anew.
  const draws = (seed, n) => { const r = processRandom(seed); return Array.from({ length: n }, () => r()); };
  assert.deepEqual(draws(S1, 3), [0.6791662241098093, 0.8127873727939283, 0.45502303021506096]);
  assert.deepEqual(draws(S2, 3), [0.6007115277024065, 0.36062226677768605, 0.8529252058074182]);
  const many = draws(S1, 4096);
  assert.deepEqual(many.slice(0, 3), draws(S1, 3));
  for (const x of many) assert.ok(x >= 0 && x < 1 && Number.isInteger(x * 2 ** 53), String(x));
  assert.equal(new Set(many).size, many.length);
  // Not the browser's Math.random stream for the same seed.
  assert.notDeepEqual(draws(S1, 2), documentAt(initScript(S1), '/p').draws().random);
});

test('a document\'s Math.random stream: the same numbers for a seed, page, path and load on every run and every version', () => {
  // Pinned to a reference made outside this package (sfc32 over a 128-bit
  // hash of "seed\npage\npath\nloads\nMath.random", 15 draws dropped, 53 bits
  // a draw): a recording keeps the seed, not the numbers, so a change here
  // would make every recording's data anew.
  assert.deepEqual(documentAt(initScript(S1), '/p').draws().random, [0.7259937449314731, 0.7408923870185994]);
  assert.deepEqual(documentAt(initScript(S1), '/p', new Map([[LOADS_KEY, '{"/p":1}']])).draws().random, [0.2929767053506992, 0.11019693928372987]);
});

test('seatRandom puts the stream in Math.random\'s place and the process\'s own back; a stub the test put there stays', () => {
  const own = Math.random;
  const r = processRandom(S1);
  const unseat = seatRandom(processRandom(S1));
  try {
    assert.notEqual(Math.random, own);
    assert.deepEqual([Math.random(), Math.random()], [r(), r()]);
  } finally { unseat(); }
  assert.equal(Math.random, own);
  // A test that stubbed Math.random over the seeded one keeps its stub.
  const stub = () => 0.25;
  const unseat2 = seatRandom(processRandom(S1));
  Math.random = stub;
  unseat2();
  assert.equal(Math.random, stub);
  Math.random = own;
});

test('while seated, a draw made as a stack trace is prepared is the process\'s own and moves no draw of the stream; Error.prepareStackTrace is put back as it was', () => {
  const E = Error;
  const before = Object.getOwnPropertyDescriptor(E, 'prepareStackTrace');
  const realRandom = Math.random;
  const back = () => {
    Math.random = realRandom;
    if (before === undefined) delete E.prepareStackTrace; else Object.defineProperty(E, 'prepareStackTrace', before);
  };
  try {
    // The process's own Math.random, and a formatter set before seating
    // that draws, as source-map's sort does while it parses a file's map.
    Math.random = () => 0.5;
    const inside = [];
    const fmt = (e, s) => { inside.push(Math.random()); return `F:${s.length}`; };
    Object.defineProperty(E, 'prepareStackTrace', { value: fmt, writable: true, enumerable: false, configurable: true });
    const r = processRandom(S1);
    const unseat = seatRandom(processRandom(S1));
    try {
      const a = Math.random();
      assert.match(new Error('x').stack, /^F:\d+$/);
      // Read twice, the same function; not enumerable, as it was.
      const old = E.prepareStackTrace;
      assert.equal(E.prepareStackTrace, old);
      assert.equal(Object.getOwnPropertyDescriptor(E, 'prepareStackTrace').enumerable, false);
      // A formatter set for a moment, as Playwright's location read does,
      // and one that calls the formatter it found before drawing itself.
      E.prepareStackTrace = (e, s) => { inside.push(Math.random()); return s; };
      const o = {};
      Error.captureStackTrace(o);
      assert.ok(Array.isArray(o.stack));
      E.prepareStackTrace = (e, s) => { const t = old(e, s); inside.push(Math.random()); return t; };
      assert.match(new Error('y').stack, /^F:\d+$/);
      E.prepareStackTrace = old;
      const b = Math.random();
      assert.deepEqual([a, b], [r(), r()]);
      assert.deepEqual(inside, [0.5, 0.5, 0.5, 0.5]);
    } finally { unseat(); }
    // The formatter last set, unwrapped, as its own property was.
    assert.equal(E.prepareStackTrace, fmt);
    assert.deepEqual(Object.getOwnPropertyDescriptor(E, 'prepareStackTrace'), { value: fmt, writable: true, enumerable: false, configurable: true });
    assert.equal(Math.random(), 0.5);

    // No formatter: none while seated, a stack still made, and none after.
    delete E.prepareStackTrace;
    const unseat2 = seatRandom(processRandom(S1));
    try {
      assert.equal(E.prepareStackTrace, undefined);
      assert.equal(typeof new Error('z').stack, 'string');
    } finally { unseat2(); }
    assert.equal(Object.getOwnPropertyDescriptor(E, 'prepareStackTrace'), undefined);
    // One set while seated stays set after, as an assignment leaves it.
    const unseat3 = seatRandom(processRandom(S1));
    try {
      E.prepareStackTrace = fmt;
      // Among Error's own keys while seated too, as an assignment lists it.
      assert.ok(Object.keys(E).includes('prepareStackTrace'));
    } finally { unseat3(); }
    assert.deepEqual(Object.getOwnPropertyDescriptor(E, 'prepareStackTrace'), { value: fmt, writable: true, enumerable: true, configurable: true });

    // A test that defines the property itself keeps its definition.
    const mine = (e, s) => s.length;
    const unseat4 = seatRandom(processRandom(S1));
    try {
      Object.defineProperty(E, 'prepareStackTrace', { value: mine, writable: false, enumerable: false, configurable: true });
    } finally { unseat4(); }
    assert.deepEqual(Object.getOwnPropertyDescriptor(E, 'prepareStackTrace'), { value: mine, writable: false, enumerable: false, configurable: true });
    // And the process's own Math.random is back after it.
    assert.equal(Math.random(), 0.5);

    // A formatter that throws (as source-map-support's does on a map it
    // cannot read) leaves the stream's draws to the test after it.
    delete E.prepareStackTrace;
    const r5 = processRandom(S2);
    const unseat5 = seatRandom(processRandom(S2));
    try {
      E.prepareStackTrace = () => { throw new Error('unreadable map'); };
      assert.throws(() => new Error('w').stack, /unreadable map/);
      E.prepareStackTrace = undefined;
      assert.equal(Math.random(), r5());
    } finally { unseat5(); }
  } finally { back(); }
});

test('setAside gives the process\'s own Math.random back under the seat until each hold is let go, once or more; a hold taken before the seat, or under an earlier one, holds nothing', () => {
  const realRandom = Math.random;
  // The process's own.
  Math.random = () => 0.5;
  try {
    const r = processRandom(S1);
    const early = setAside();
    const unseat = seatRandom(processRandom(S1));
    try {
      assert.equal(Math.random(), r());
      const a = setAside();
      const b = setAside();
      assert.equal(Math.random(), 0.5);
      a(); a();
      assert.equal(Math.random(), 0.5);
      b();
      early();
      // No draw of the stream was taken while held.
      assert.equal(Math.random(), r());
    } finally { unseat(); }
    const unseat1 = seatRandom(processRandom(S1));
    const late = setAside();
    unseat1();
    const r2 = processRandom(S2);
    const unseat2 = seatRandom(processRandom(S2));
    try {
      assert.equal(Math.random(), r2());
      late();
      assert.equal(Math.random(), r2());
    } finally { unseat2(); }
    assert.equal(Math.random(), 0.5);
  } finally { Math.random = realRandom; }
});

// A faker instance's randomizer as faker makes one: its own next and seed.
const fakeRandomizer = (v) => {
  const seeds = [];
  return { seeds, r: { next() { return v; }, seed(...a) { seeds.push(a); } } };
};

test('a named stream of the test process: the same numbers for a seed and name on every run and every version, others for another name; Math.random\'s is the unnamed one', () => {
  assert.deepEqual([processRandom(S1, 'Math.random')(), processRandom(S1, 'Math.random')()], [processRandom(S1)(), processRandom(S1)()]);
  const f = processRandom(S1, `${FAKER} faker`);
  // Pinned to a reference made outside this package (sfc32 over the SHA-256
  // of the seed, "test process" and the name): a recording keeps the seed,
  // not the numbers.
  assert.deepEqual([f(), f()], [0.9618393967615386, 0.5619964902771277]);
  assert.notEqual(processRandom(S1, `${FAKER} faker`)(), processRandom(S1)());
  assert.notEqual(processRandom(S1, `${FAKER} faker`)(), processRandom(S1, `${FAKER} fakerDE`)());
  assert.notEqual(processRandom(S1, `${FAKER} faker`)(), processRandom(S2, `${FAKER} faker`)());
});

test('seatFaker puts each instance\'s draws on its named stream of the seed and its own back; setAside, and a test that seeds the instance itself, give it its own; a replacement the test put there stays', () => {
  const realRandom = Math.random;
  try {
    const a = fakeRandomizer(0.25);
    const b = fakeRandomizer(0.75);
    const ownA = a.r.next;
    const ownSeedA = a.r.seed;
    const ownB = b.r.next;
    const mine = () => 0.5;
    const unseat = seatRandom(processRandom(S1));
    const unseatFaker = seatFaker(S1, [['faker', a.r], ['fakerDE', b.r]]);
    const fa = processRandom(S1, `${FAKER} faker`);
    const fb = processRandom(S1, `${FAKER} fakerDE`);
    const m = processRandom(S1);
    try {
      assert.equal(a.r.next(), fa());
      // One instance's draws move neither another's nor Math.random's.
      assert.equal(b.r.next(), fb());
      assert.equal(Math.random(), m());
      assert.equal(a.r.next(), fa());
      // While a worker fixture is set up, its own; no draw of the stream taken.
      const back = setAside();
      assert.equal(a.r.next(), 0.25);
      assert.equal(b.r.next(), 0.75);
      back();
      assert.equal(a.r.next(), fa());
      // The test seeds a itself: a's own seed is called as asked, and a
      // draws its own from then on; b stays seated.
      assert.equal(a.r.seed(7), undefined);
      assert.deepEqual(a.seeds, [[7]]);
      assert.equal(a.r.next, ownA);
      assert.equal(a.r.seed, ownSeedA);
      assert.equal(a.r.next(), 0.25);
      assert.equal(b.r.next(), fb());
      // A replacement the test put on b stays.
      b.r.next = mine;
    } finally {
      unseatFaker();
      unseat();
    }
    assert.equal(a.r.next, ownA);
    assert.equal(b.r.next, mine);
    assert.notEqual(b.r.next, ownB);
    assert.equal(b.r.next(), 0.5);
    // With nothing found, a seat changes nothing.
    seatFaker(S1, [])();
  } finally { Math.random = realRandom; }
});

test('seatFaker puts back the seed of an instance the test did not seed, and leaves one the test replaced', () => {
  const a = fakeRandomizer(0.25);
  const ownSeed = a.r.seed;
  const unseat = seatRandom(processRandom(S1));
  const un = seatFaker(S1, [['faker', a.r]]);
  assert.notEqual(a.r.seed, ownSeed);
  un();
  unseat();
  assert.equal(a.r.seed, ownSeed);
  const c = fakeRandomizer(0.25);
  const unseat2 = seatRandom(processRandom(S1));
  const un2 = seatFaker(S1, [['faker', c.r]]);
  const theirs = () => 'theirs';
  c.r.seed = theirs;
  un2();
  unseat2();
  assert.equal(c.r.seed, theirs);
});

// An instance as faker 10 makes one (its fakerCore's randomizer) or faker 8
// and 9 do (its _randomizer).
const instance10 = (v) => { const f = fakeRandomizer(v); return { ...f, i: { fakerCore: { randomizer: f.r } } }; };
const instance9 = (v) => { const f = fakeRandomizer(v); return { ...f, i: { _randomizer: f.r } }; };

test('seedFaker refuses, naming the next step, a value that is no faker instance it can seed, and an empty name', () => {
  const noInstance = /^keploy: seedFaker\(instance, name\) was given no faker instance it can seed: give it an instance of @faker-js\/faker 8, 9 or 10 \(new Faker\(\.\.\.\) or new SimpleFaker\(\.\.\.\)\)$/;
  for (const v of [null, undefined, 3, 'faker', {}, { fakerCore: null }, { fakerCore: { randomizer: { next() { return 0; } } } }, { _randomizer: 5 }]) {
    assert.throws(() => seedFaker(v, 'mine'), (e) => e instanceof TypeError && noInstance.test(e.message), String(v));
  }
  const noName = 'keploy: seedFaker(instance, name) was given no name: give each instance its own name (such as \'mine\'), ' +
    'which names the stream of each test\'s seed it draws from';
  for (const n of [undefined, null, 3, '', '  ']) {
    const a = instance10(0.25);
    assert.throws(() => seedFaker(a.i, n), (e) => e instanceof TypeError && e.message === noName, String(n));
    // A refused instance is not seeded.
    const realRandom = Math.random;
    const unseat = seatRandom(processRandom(S1));
    const un = seatFaker(S1, []);
    try {
      assert.equal(a.r.next(), 0.25);
    } finally {
      un();
      unseat();
      Math.random = realRandom;
    }
  }
});

test('seedFaker: an instance given outside a test is seated in every seat after, on its own stream of the seed named by its name, never a prebuilt instance\'s; it returns the instance; one name gives two instances the same draws', () => {
  const realRandom = Math.random;
  try {
    const a = instance10(0.25);
    const b = instance9(0.75);
    const c = instance10(0.5);
    const ownA = a.r.next;
    assert.equal(seedFaker(a.i, 'faker'), a.i);
    assert.equal(seedFaker(b.i, 'theirs'), b.i);
    assert.equal(seedFaker(c.i, 'theirs'), c.i);
    // Given, it still draws its own outside every seat.
    assert.equal(a.r.next(), 0.25);
    for (const seed of [S1, S2]) {
      const unseat = seatRandom(processRandom(seed));
      const un = seatFaker(seed, []);
      // Pinned to the stream's name: a recording keeps the seed, not the numbers.
      const fa = processRandom(seed, '@faker-js/faker own faker');
      const fb = processRandom(seed, '@faker-js/faker own theirs');
      const fc = processRandom(seed, '@faker-js/faker own theirs');
      const prebuilt = processRandom(seed, '@faker-js/faker faker');
      try {
        const x = a.r.next();
        assert.equal(x, fa());
        assert.notEqual(x, prebuilt());
        assert.equal(b.r.next(), fb());
        assert.equal(c.r.next(), fc());
        assert.equal(Math.random(), processRandom(seed)());
        // It draws its own while a worker fixture is set up.
        const back = setAside();
        assert.equal(a.r.next(), 0.25);
        back();
      } finally {
        un();
        unseat();
      }
      assert.equal(a.r.next, ownA);
      assert.equal(a.r.next(), 0.25);
    }
  } finally { Math.random = realRandom; }
});

test('seedFaker: an instance given in a test is seated at once until that test\'s end, and not in the seats after; one given while a worker fixture is set up is seated in this seat and every one after; one found prebuilt is seated once, by its found name', () => {
  const realRandom = Math.random;
  try {
    const t = instance10(0.25);
    const w = instance9(0.75);
    const p = instance10(0.5);
    const ownT = t.r.next;
    const unseat = seatRandom(processRandom(S1));
    const un = seatFaker(S1, [['faker', p.r]]);
    try {
      assert.equal(t.r.next(), 0.25);
      assert.equal(seedFaker(t.i, 'in a test'), t.i);
      const ft = processRandom(S1, '@faker-js/faker own in a test');
      assert.equal(t.r.next(), ft());
      assert.equal(t.r.next(), ft());
      // Given again, under another name, it keeps its stream.
      seedFaker(t.i, 'other');
      assert.equal(t.r.next(), ft());
      // A worker fixture being set up gives it: its own until set up, then
      // the test's stream.
      const back = setAside();
      seedFaker(w.i, 'worker');
      assert.equal(w.r.next(), 0.75);
      back();
      assert.equal(w.r.next(), processRandom(S1, '@faker-js/faker own worker')());
      // A prebuilt instance the suite gives too keeps its found stream.
      const fp = processRandom(S1, '@faker-js/faker faker');
      seedFaker(p.i, 'mine too');
      assert.equal(p.r.next(), fp());
      assert.equal(p.r.next(), fp());
    } finally {
      un();
      unseat();
    }
    assert.equal(t.r.next, ownT);
    assert.equal(t.r.next(), 0.25);
    assert.equal(p.r.next(), 0.5);
    // The next seat: the test's instance draws its own; the worker's is seated.
    const unseat2 = seatRandom(processRandom(S2));
    const un2 = seatFaker(S2, []);
    try {
      assert.equal(t.r.next(), 0.25);
      assert.equal(w.r.next(), processRandom(S2, '@faker-js/faker own worker')());
      assert.equal(p.r.next(), 0.5);
    } finally {
      un2();
      unseat2();
    }
    // Given after the seat ended, an instance waits for the next seat.
    const after = instance10(0.125);
    seedFaker(after.i, 'after');
    assert.equal(after.r.next(), 0.125);
    const unseat3 = seatRandom(processRandom(S1));
    const un3 = seatFaker(S1, []);
    try {
      assert.equal(after.r.next(), processRandom(S1, '@faker-js/faker own after')());
    } finally {
      un3();
      unseat3();
    }
    // An older seat put back after a newer one began leaves the newer one in place.
    const unseat4 = seatRandom(processRandom(S2));
    const old = seatFaker(S1, []);
    const newer = seatFaker(S2, []);
    old();
    const late = instance10(0.375);
    seedFaker(late.i, 'late');
    assert.equal(late.r.next(), processRandom(S2, '@faker-js/faker own late')());
    newer();
    unseat4();
    assert.equal(late.r.next(), 0.375);
  } finally { Math.random = realRandom; }
});

test('esmFile: .mjs and .mts files are ES modules and .cjs and .cts are not; any other is one when its nearest package.json says "type": "module"', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpw-esm-'));
  try {
    for (const [f, want] of [['a.mjs', true], ['a.mts', true], ['a.cjs', false], ['a.cts', false]]) assert.equal(esmFile(path.join(tmp, f)), want, f);
    fs.mkdirSync(path.join(tmp, 'm', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'm', 'package.json'), '{"type":"module"}');
    assert.equal(esmFile(path.join(tmp, 'm', 'deep', 'a.spec.ts')), true);
    assert.equal(esmFile(path.join(tmp, 'm', 'deep', 'a.cts')), false);
    // The nearest package.json decides, even one with no type.
    fs.writeFileSync(path.join(tmp, 'm', 'deep', 'package.json'), '{"name":"x"}');
    assert.equal(esmFile(path.join(tmp, 'm', 'deep', 'a.spec.ts')), false);
    fs.writeFileSync(path.join(tmp, 'm', 'deep', 'package.json'), '{"type":"commonjs"}');
    assert.equal(esmFile(path.join(tmp, 'm', 'deep', 'a.spec.js')), false);
    // One keploy cannot read as JSON: not an ES module.
    fs.writeFileSync(path.join(tmp, 'm', 'deep', 'package.json'), '{');
    assert.equal(esmFile(path.join(tmp, 'm', 'deep', 'a.spec.ts')), false);
    fs.writeFileSync(path.join(tmp, 'm', 'deep', 'package.json'), 'null');
    assert.equal(esmFile(path.join(tmp, 'm', 'deep', 'a.spec.ts')), false);
    // This package's own test files are CommonJS.
    assert.equal(esmFile(fileURLToPath(import.meta.url).replace(/\.mjs$/, '.ts')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('exportOf picks a package\'s main entry as Node does: the first condition in the object\'s order, nested, in an array the first that gives a file', () => {
  const imp = ['node', 'import', 'module-sync', 'default'];
  assert.equal(exportOf('./i.js', imp), './i.js');
  assert.equal(exportOf({ '.': './d.js', './x': './x.js' }, imp), './d.js');
  assert.equal(exportOf({ './x': './x.js' }, imp), null);
  // faker 9's: require first, but an import takes default.
  const f9 = { '.': { require: { types: './i.d.cts', default: './i.cjs' }, default: { types: './i.d.ts', default: './i.js' } } };
  assert.equal(exportOf(f9, imp), './i.js');
  assert.equal(exportOf(f9, ['require', 'default']), './i.cjs');
  // Key order decides, not the conditions' order.
  assert.equal(exportOf({ default: './d.js', import: './i.js' }, imp), './d.js');
  assert.equal(exportOf({ browser: './b.js', import: './i.js' }, imp), './i.js');
  // A condition whose target gives no file passes to the next.
  assert.equal(exportOf({ import: { browser: './b.js' }, default: './d.js' }, imp), './d.js');
  assert.equal(exportOf([{ browser: './b.js' }, './a.js'], imp), './a.js');
  assert.equal(exportOf([{ browser: './b.js' }], imp), null);
  assert.equal(exportOf({ browser: './b.js' }, imp), null);
  for (const v of [null, undefined, 3, true]) assert.equal(exportOf(v, imp), null, String(v));
});

test('fakersIn finds each faker instance a module exports once, by its export\'s name, in the names\' order; allFakers\' are named by their fakerXX export', async () => {
  const m = await import('@faker-js/faker');
  const found = fakersIn(m);
  const names = found.map(([n]) => n);
  assert.ok(names.includes('faker') && names.includes('fakerDE') && names.includes('simpleFaker'), names.join(' '));
  assert.ok(!names.some((n) => n.startsWith('allFakers.')), names.join(' '));
  assert.deepEqual(names, [...names].sort());
  const rs = found.map(([, r]) => r);
  assert.equal(new Set(rs).size, rs.length);
  assert.equal(found.find(([n]) => n === 'faker')[1], m.faker.fakerCore.randomizer);
  for (const v of Object.values(m.allFakers)) assert.ok(rs.includes(v.fakerCore.randomizer));
  // faker 8 and 9 keep theirs in _randomizer; one only in allFakers is named there.
  const old = fakeRandomizer(0.5).r;
  const only = fakeRandomizer(0.5).r;
  assert.deepEqual(fakersIn({ faker: { _randomizer: old }, allFakers: { xx: { _randomizer: only }, de: { _randomizer: old } } }), [['faker', old], ['allFakers.xx', only]]);
  // Neither an instance nor a module.
  assert.deepEqual(fakersIn({ a: 1, b: { fakerCore: null }, c: { _randomizer: { next() { return 0; } } }, d: { fakerCore: { randomizer: 5 } }, allFakers: 3 }), []);
  for (const v of [null, undefined, 'm', 3]) assert.deepEqual(fakersIn(v), []);
  const throwing = { get faker() { throw new Error('not yet'); }, other: { get fakerCore() { throw new Error('no'); } }, get allFakers() { throw new Error('no'); } };
  assert.deepEqual(fakersIn(throwing), []);
});

test('fakersOf gives a test file the faker instances its own import gets, CommonJS or ES module, the same ones each time; none where it cannot import faker; a problem where it can but keploy cannot load it', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const m = await import('@faker-js/faker');
  for (const f of ['fixtures/faker.spec.ts', 'fixtures/faker-esm.spec.mts']) {
    const got = fakersOf(path.join(here, f));
    assert.equal(got.problem, '', f);
    assert.equal(got.found.find(([n]) => n === 'faker')[1], m.faker.fakerCore.randomizer, f);
    assert.equal(fakersOf(path.join(here, f)), got, f);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpw-faker-'));
  try {
    assert.deepEqual(fakersOf(path.join(tmp, 'a.spec.ts')), { found: [], problem: '' });
    // A faker whose exports give no file for this kind of test file.
    const pkg = (dir, json, files) => {
      const d = path.join(tmp, dir, 'node_modules', '@faker-js', 'faker');
      fs.mkdirSync(path.join(d, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: FAKER, ...json }));
      for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(d, n), body);
    };
    pkg('imp', { exports: { '.': { import: './dist/i.mjs' } } }, { 'dist/i.mjs': 'export const x = 1;\n' });
    const imp = fakersOf(path.join(tmp, 'imp', 'a.spec.ts'));
    assert.deepEqual(imp.found, []);
    assert.match(imp.problem, /\S/);
    // An ES module test file of a faker that exports nothing for import.
    pkg('noimp', { exports: { '.': { require: './dist/i.cjs' } } }, { 'dist/i.cjs': 'exports.x = 1;\n' });
    assert.deepEqual(fakersOf(path.join(tmp, 'noimp', 'a.spec.mts')), { found: [], problem: 'its package.json exports no file for import' });
    // One that loads but exports no instance; one with no exports but a main.
    pkg('none', { main: 'dist/m.cjs' }, { 'dist/m.cjs': 'exports.x = 1;\n' });
    assert.deepEqual(fakersOf(path.join(tmp, 'none', 'a.spec.ts')), { found: [], problem: 'it exports no instance keploy knows how to seed (faker 8, 9 and 10 do)' });
    assert.deepEqual(fakersOf(path.join(tmp, 'none', 'a.spec.mts')), { found: [], problem: 'it exports no instance keploy knows how to seed (faker 8, 9 and 10 do)' });
    // An ES module test file gets the import's copy, a CommonJS one the require's.
    const inst = (v) => `{ fakerCore: { randomizer: { next() { return ${v}; }, seed() {} } } }`;
    pkg('dual', { exports: { '.': { require: './dist/i.cjs', default: './dist/i.mjs' } } }, {
      'dist/i.cjs': `exports.faker = ${inst(0.1)};\n`,
      'dist/i.mjs': `export const faker = ${inst(0.2)};\n`,
    });
    assert.equal(fakersOf(path.join(tmp, 'dual', 'a.spec.ts')).found[0][1].next(), 0.1);
    assert.equal(fakersOf(path.join(tmp, 'dual', 'a.spec.mts')).found[0][1].next(), 0.2);
    // A package keploy cannot find the root of from its entry.
    pkg('noroot', { name: 'other', main: 'dist/m.cjs' }, { 'dist/m.cjs': 'exports.x = 1;\n' });
    assert.match(fakersOf(path.join(tmp, 'noroot', 'a.spec.mts')).problem, /^no package\.json of @faker-js\/faker holds /);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the line for a faker keploy cannot seed names the reason and the next step', () => {
  assert.equal(fakerLine('Cannot find module x'), 'keploy: @faker-js/faker is installed where the tests import it, but keploy cannot seed it (Cannot find module x), ' +
    'so what its instances make (a name, an email, an ID) differs from its recording\'s at replay while a mocked dependency answers with the recording\'s. ' +
    'Fix what the message names (an ES module needs Node 20.19, 22.12 or later to be loaded here), or seed it in a beforeEach (faker.seed(n)).');
  assert.match(fakerLine('a\nb'), /cannot seed it \(a\?b\)/);
});

test('a seeded document draws the same numbers for the same seed and path, others for another seed or path', () => {
  const s1 = initScript(S1);
  const a = documentAt(s1, '/p').draws();
  assert.deepEqual(documentAt(s1, '/p').draws(), a);
  assert.notDeepEqual(documentAt(initScript(S2), '/p').draws(), a);
  assert.notDeepEqual(documentAt(s1, '/q').draws(), a);
  for (const r of a.random) assert.ok(r >= 0 && r < 1 && r !== 0, String(r));
  // 53 bits a draw, as the browser's own: not a 32-bit value scaled.
  const many = JSON.parse(documentAt(s1).run('JSON.stringify(Array.from({ length: 16 }, () => Math.random()))'));
  assert.ok(many.some((r) => (r * 4294967296) % 1 !== 0), many.join(' '));
  assert.match(a.uuid, UUID_V4);
  assert.equal(a.bytes.length, 8);
  // Unseeded draws differ every time.
  assert.notDeepEqual(documentAt('', '/p').draws(), documentAt('', '/p').draws());
});

// Each seeded function's own property flags and source, as a document sees them.
const FLAGS = `JSON.stringify([[Math, 'random'], [Crypto.prototype, 'getRandomValues'], [Crypto.prototype, 'randomUUID']].map(([o, k]) => {
  const p = Object.getOwnPropertyDescriptor(o, k);
  return p ? [k, p.writable, p.enumerable, p.configurable, String(p.value)] : [k];
}))`;

test('a seeded document\'s Math.random, getRandomValues and randomUUID keep the browser\'s property flags: a page that lists Math\'s keys sees none', () => {
  const own = JSON.parse(documentAt(null, '/p').run(FLAGS));
  const seeded = JSON.parse(documentAt(initScript(S1), '/p').run(FLAGS));
  // The seeding put its own functions in place, with the flags the browser's own had.
  for (const [i, f] of seeded.entries()) assert.notEqual(f[4], own[i][4], f[0]);
  assert.deepEqual(seeded.map((f) => f.slice(0, 4)), own.map((f) => f.slice(0, 4)));
  assert.deepEqual(own.map((f) => f.slice(0, 4)), [['random', true, false, true], ['getRandomValues', true, false, true], ['randomUUID', true, false, true]]);
  assert.deepEqual(JSON.parse(documentAt(initScript(S1), '/p').run('JSON.stringify(Object.keys(Math))')), []);
});

test('the seeding keeps a Math.random a script before it made read-only read-only, and gives a method Crypto.prototype only inherits an own one, writable and not enumerable; both draw the seeded numbers', () => {
  const seeded = documentAt(initScript(S1), '/p').draws();
  const FROZEN = "Object.defineProperty(Math, 'random', { writable: false });\n";
  const frozenOwn = JSON.parse(documentAt(FROZEN, '/p').run(FLAGS));
  assert.deepEqual(frozenOwn[0].slice(0, 4), ['random', false, false, true]);
  const frozen = documentAt(FROZEN + initScript(S1), '/p');
  const frozenFlags = JSON.parse(frozen.run(FLAGS));
  assert.deepEqual(frozenFlags[0].slice(0, 4), frozenOwn[0].slice(0, 4));
  assert.notEqual(frozenFlags[0][4], frozenOwn[0][4]);
  assert.deepEqual(frozen.draws(), seeded);
  // As a browser whose Crypto.prototype inherits both methods from a base.
  const INHERITED = `{
  const base = Object.create(Object.getPrototypeOf(Crypto.prototype));
  for (const k of ['getRandomValues', 'randomUUID']) {
    Object.defineProperty(base, k, Object.getOwnPropertyDescriptor(Crypto.prototype, k));
    delete Crypto.prototype[k];
  }
  Object.setPrototypeOf(Crypto.prototype, base);
}\n`;
  assert.deepEqual(JSON.parse(documentAt(INHERITED, '/p').run(FLAGS)).slice(1), [['getRandomValues'], ['randomUUID']]);
  const inherited = documentAt(INHERITED + initScript(S1), '/p');
  assert.deepEqual(JSON.parse(inherited.run(FLAGS)).slice(1).map((f) => f.slice(0, 4)), [['getRandomValues', true, false, true], ['randomUUID', true, false, true]]);
  assert.deepEqual(inherited.draws(), seeded);
});

test('each page the test opened draws its own numbers at one path, the same ones each run; its place is named in every document after the seeding script', () => {
  const s = initScript(S1);
  const first = documentAt(s, '/p', new Map(), 't0').draws();
  const second = documentAt(s, '/p', new Map(), 't1').draws();
  // Two tabs of one test, each in a fresh session storage, at one path: a
  // browser-made tab ID or idempotency key is not sent twice.
  assert.notEqual(second.uuid, first.uuid);
  assert.notDeepEqual(second, first);
  // Each page draws the same numbers each run (record and replay).
  assert.deepEqual(documentAt(s, '/p', new Map(), 't0').draws(), first);
  assert.deepEqual(documentAt(s, '/p', new Map(), 't1').draws(), second);
  // The page's name is read at the first draw, so the page script, which
  // the browser runs after the context's, still names it; the window shows
  // neither the name nor the seeding's state to the page's own scripts.
  const d = documentAt(s, '/p', new Map(), 't1');
  assert.deepEqual(JSON.parse(d.run(`JSON.stringify([Object.keys(globalThis).filter((k) => k.startsWith('__keploy')), globalThis[${JSON.stringify(PAGE_KEY)}], typeof globalThis[${JSON.stringify(DOC_KEY)}]])`)),
    [[], 't1', 'object']);
  assert.match(pageScript('t3'), /"t3"/);
});

test('a document no page names and no opener places draws the browser\'s own numbers, never another page\'s, and tells the fixture once, at its first draw', () => {
  const told = [];
  const s = initScript(S1, '__report');
  const d = documentAt(s, '/p', new Map(), null, { report: '__report', told });
  // Nothing is told before a draw, and the report function is taken off the
  // window as the document begins.
  assert.deepEqual(told, []);
  assert.equal(d.run('typeof globalThis.__report'), 'undefined');
  const a = d.draws();
  assert.deepEqual(told, ['http://h/p']);
  const b = d.draws();
  assert.deepEqual(told, ['http://h/p']);
  assert.notDeepEqual(b, a);
  // Not the draws of a page the test opened, at that path or any.
  assert.notDeepEqual(documentAt(s, '/p', new Map(), null).draws(), documentAt(s, '/p', new Map(), null).draws());
  assert.notDeepEqual(a, documentAt(s, '/p', new Map(), 't0').draws());
  assert.match(a.uuid, UUID_V4);
  assert.equal(a.bytes.length, 8);
  for (const r of a.random) assert.ok(r >= 0 && r < 1, String(r));
  // With no function to tell, it still draws its own.
  assert.notDeepEqual(documentAt(initScript(S1), '/p', new Map(), null).draws(), documentAt(initScript(S1), '/p', new Map(), null).draws());
  // An opaque origin tells its URL with no query or fragment, never its
  // origin's "null" before its path.
  for (const [href, at] of [['about:blank', 'about:blank'], ['about:srcdoc?q#f', 'about:srcdoc'], ['http://h/sandboxed#f', 'http://h/sandboxed']]) {
    const o = [];
    documentAt(s, 'blank', null, null, { report: '__report', told: o, origin: 'null', href }).draws();
    assert.deepEqual(o, [at], href);
  }
  const e = [];
  documentAt(s, 'blank', null, null, { report: '__report', told: e, origin: '', href: 'about:blank#x' }).draws();
  assert.deepEqual(e, ['about:blank']);
  // A window's first document with no URL yet (Firefox, as its init
  // scripts run) is about:blank.
  const none = [];
  documentAt(s, '', null, null, { report: '__report', told: none, origin: '', href: '' }).draws();
  assert.deepEqual(none, ['about:blank']);
});

test('a document loaded again in the same tab draws new numbers, the same ones each run', () => {
  const s = initScript(S1);
  const run = () => { const tab = new Map(); return [documentAt(s, '/p', tab).draws(), documentAt(s, '/p', tab).draws(), documentAt(s, '/q', tab).draws()]; };
  const [first, again, other] = run();
  assert.notDeepEqual(again, first);
  assert.deepEqual(run(), [first, again, other]);
  // Another path's count is its own: /q is its first load, as in a fresh tab.
  assert.deepEqual(other, documentAt(s, '/q').draws());
  const tab = new Map();
  documentAt(s, '/p', tab); documentAt(s, '/p', tab);
  assert.deepEqual(JSON.parse(tab.get(LOADS_KEY)), { '/p': 2 });
});

test('a top document with no session storage draws the browser\'s own numbers and says why, once, but for a page\'s first document, which its mark seeds; with an unreadable count, a document still draws seeded numbers', () => {
  const s = initScript(S1);
  const r = initScript(S1, 'rep', 'MK');
  // A page's document, then a popup its opener places: never seeded with no
  // session storage, each told once, with why; seeded with it.
  const opener = { [DOC_KEY]: { opened: () => ({ indexOf: () => 0 }), key: () => 'K\n' } };
  for (const [page, o, as] of [['t0', undefined, 't0'], [null, opener, 'K\nw0']]) {
    const told = [];
    const d = documentAt(r, '/p', null, page, { report: 'rep', told, opener: o });
    const a = d.draws();
    d.draws();
    assert.deepEqual(told, [['http://h/p', 'nostorage']], as);
    assert.notDeepEqual(a, documentAt(s, '/p', new Map(), as).draws(), as);
    assert.notDeepEqual(documentAt(s, '/p', null, page, { opener: o }).draws(), documentAt(s, '/p', null, page, { opener: o }).draws(), as);
    const kept = [];
    assert.deepEqual(documentAt(r, '/p', new Map(), page, { report: 'rep', told: kept, opener: o }).draws(), documentAt(s, '/p', new Map(), as).draws(), as);
    assert.deepEqual(kept, [], as);
  }
  // Session storage the app has filled (setItem throws): its loads cannot be
  // counted, so the same.
  const full = new (class extends Map { set() { throw new Error('QuotaExceededError'); } })();
  const fullTold = [];
  assert.notDeepEqual(documentAt(r, '/p', full, 't0', { report: 'rep', told: fullTold }).draws(), documentAt(s, '/p', new Map(), 't0').draws());
  assert.deepEqual(fullTold, [['http://h/p', 'nostorage']]);
  // A page's first document, marked by firstScript as newPage returns, is
  // seeded with no count, the same each run; a document that takes its
  // window over after the mark is not, and says why.
  const first = () => {
    const told = [];
    const d = documentAt(r, 'blank', null, null, { report: 'rep', told, origin: 'null', href: 'about:blank', doc: { querySelectorAll: () => [] } });
    d.run(firstScript('t0', 'MK'));
    return { d, told };
  };
  const f = first();
  // The mark is the seeding's state for the document: the window holds no
  // property of it beside the page's name and the document's place.
  assert.deepEqual(JSON.parse(f.d.run(`JSON.stringify(Object.getOwnPropertyNames(globalThis).filter((k) => k.startsWith('__keploy')).sort())`)), [DOC_KEY, PAGE_KEY].sort());
  const a = f.d.draws();
  assert.deepEqual(a, documentAt(s, 'blank', new Map(), 't0').draws());
  assert.deepEqual(first().d.draws(), a);
  assert.deepEqual(f.told, []);
  const later = first();
  later.d.ctx.document = { querySelectorAll: () => [] };
  assert.notDeepEqual(later.d.draws(), a);
  assert.deepEqual(later.told, [['about:blank', 'nostorage']]);
  // The mark is for the document it runs in: one that took the window over
  // before the mark ran in it is the one marked.
  const over = documentAt(r, 'blank', null, null, { origin: 'null', href: 'about:blank', doc: { querySelectorAll: () => [] } });
  over.ctx.document = { querySelectorAll: () => [] };
  over.run(firstScript('t0', 'MK'));
  assert.deepEqual(over.draws(), a);
  // A page's own script that marks its document with another value, or
  // with none, does not seed it; nor does the right one in a script given
  // no mark.
  for (const [script, m] of [[r, 'other'], [r, undefined], [r, ''], [initScript(S1, 'rep'), '']]) {
    const told = [];
    const d = documentAt(script, 'blank', null, null, { report: 'rep', told, origin: 'null', href: 'about:blank', doc: { querySelectorAll: () => [] } });
    d.run(pageScript('t0') + `globalThis[${JSON.stringify(DOC_KEY)}].first(${m === undefined ? '' : JSON.stringify(m)});`);
    assert.notDeepEqual(d.draws(), a, String(m));
    assert.deepEqual(told, [['about:blank', 'nostorage']], String(m));
  }
  // The page's name alone, with no mark: not its first document.
  const named = [];
  assert.notDeepEqual(documentAt(r, 'blank', null, 't0', { report: 'rep', told: named, origin: 'null', href: 'about:blank', doc: { querySelectorAll: () => [] } }).draws(), a);
  assert.deepEqual(named, [['about:blank', 'nostorage']]);
  // Junk in the tab's count is read as no loads and replaced by a count, so
  // the tab's next document at the path draws as its second load.
  for (const junk of ['not json', '[1,2]', '5', 'null', '{"/p":"x"}']) {
    const tab = new Map([[LOADS_KEY, junk]]);
    assert.deepEqual(documentAt(s, '/p', tab).draws(), documentAt(s, '/p').draws(), junk);
    assert.equal(tab.get(LOADS_KEY), '{"/p":1}', junk);
  }
});

test('a page\'s first document that drew before keploy named it keeps the place it drew in, none: the frames and popups that ask it after are not given the name it got later', () => {
  // A script the test added to its context draws as the first document
  // begins, before newPage returns and keploy names the page: it draws the
  // browser's own and says so once. Its key, which its frames and the
  // popups it opens are placed by, stays none after the name and the mark.
  const api = `globalThis[${JSON.stringify(DOC_KEY)}]`;
  const first = (drawn) => {
    const told = [];
    const d = documentAt(initScript(S1, 'rep', 'MK'), 'blank', null, null, { report: 'rep', told, origin: 'null', href: 'about:blank', doc: { querySelectorAll: () => [] } });
    if (drawn) d.draws();
    d.run(firstScript('t0', 'MK'));
    return { d, told };
  };
  const early = first(true);
  assert.equal(early.d.run(`${api}.key()`), null);
  assert.equal(early.d.run(`${api}.key()`), null);
  assert.equal(early.d.run(`${api}.why()`), '');
  assert.notDeepEqual(early.d.draws(), early.d.draws());
  assert.deepEqual(early.told, ['about:blank']);
  // Named before it drew: placed by the name, each time it is asked.
  const named = first(false);
  const k = `${S1}\nt0\nblank\n0\n`;
  assert.equal(named.d.run(`${api}.key()`), k);
  assert.deepEqual(named.d.draws(), documentAt(initScript(S1), 'blank', new Map(), 't0').draws());
  assert.equal(named.d.run(`${api}.key()`), k);
  assert.deepEqual(named.told, []);
});

test('each function has its own stream: extra draws of one do not move another\'s', () => {
  const s = initScript(S1);
  const d = documentAt(s);
  const base = documentAt(s).draws();
  d.run('for (let i = 0; i < 7; i++) Math.random();');
  const after = d.draws();
  assert.deepEqual(after.bytes, base.bytes);
  assert.equal(after.uuid, base.uuid);
  assert.notDeepEqual(after.random, base.random);
  const e = documentAt(s);
  e.run('crypto.getRandomValues(new Uint8Array(3)); crypto.randomUUID();');
  assert.deepEqual(e.draws().random, base.random);
});

test('getRandomValues fills the array it was given and returns it; what the browser refuses it still refuses', () => {
  const d = documentAt(initScript(S1));
  assert.equal(d.run('(() => { const a = new Uint32Array(5); return crypto.getRandomValues(a) === a && a.some((x) => x !== 0); })()'), true);
  // A view into the middle of a buffer is filled there only.
  assert.equal(d.run('(() => { const b = new Uint8Array(12); crypto.getRandomValues(new Uint8Array(b.buffer, 4, 4)); return b.slice(0, 4).every((x) => x === 0) && b.slice(8).every((x) => x === 0); })()'), true);
  assert.throws(() => d.run('crypto.getRandomValues(new Float32Array(2))'));
  assert.throws(() => d.run('crypto.getRandomValues(new Uint8Array(65537))'));
  // Called on a this that is no Crypto, either function throws as the
  // browser's own does, and draws nothing from its stream.
  const f = documentAt(initScript(S1));
  assert.throws(() => f.run('crypto.getRandomValues.call({}, new Uint8Array(4))'), /Illegal invocation/);
  assert.throws(() => f.run('crypto.randomUUID.call({})'), /Illegal invocation/);
  assert.throws(() => f.run('Crypto.prototype.randomUUID()'), /Illegal invocation/);
  assert.throws(() => f.run('crypto.getRandomValues(new Float32Array(2))'));
  assert.deepEqual(f.draws(), documentAt(initScript(S1)).draws());
  // The functions keep their names and lengths, and stay on the prototype.
  assert.deepEqual(JSON.parse(d.run('JSON.stringify([Math.random.name, Math.random.length, crypto.getRandomValues.name, crypto.getRandomValues.length, crypto.randomUUID.name, Object.keys(crypto).length])')),
    ['random', 0, 'getRandomValues', 1, 'randomUUID', 0]);
});

test('a document without crypto.randomUUID (not a secure context) is not given one', () => {
  class Crypto { getRandomValues(a) { return a; } }
  const d = documentAt('');
  d.ctx.Crypto = Crypto;
  d.ctx.crypto = new Crypto();
  d.run(initScript(S1));
  assert.equal(d.run('typeof crypto.randomUUID'), 'undefined');
  assert.equal(d.run('typeof Math.random()'), 'number');
});

test('a page the test asked for is the test\'s own when its first document tells while its newPage has not come; it is named in the order the test asked', async () => {
  // A context whose pages come only when the row says, so the order is the
  // row's, not the browser's.
  const asked = [];
  const original = function newPage() { return new Promise((resolve) => asked.push(resolve)); };
  const context = { newPage: original };
  const fakePage = () => {
    const scripts = [];
    return { scripts, addInitScript: async (s) => { scripts.push(s.content); }, evaluate: async (s) => { scripts.push(s); } };
  };
  const placing = placePages(context, 'MK');
  const first = fakePage(), second = fakePage(), popup = fakePage();
  const a = context.newPage(), b = context.newPage();
  // Both first documents tell before either newPage has come.
  const firstOwn = placing.opened(first), secondOwn = placing.opened(second), popupOwn = placing.opened(popup);
  // The second comes first: each keeps the place it was asked in.
  asked[1](second);
  asked[0](first);
  assert.equal(await a, first);
  assert.equal(await b, second);
  assert.deepEqual([await firstOwn, await secondOwn, await popupOwn], [true, true, false]);
  // Its later documents' script, then its first document's, which marks it
  // with the context's mark.
  assert.deepEqual(first.scripts, [pageScript('t0'), firstScript('t0', 'MK')]);
  assert.deepEqual(second.scripts, [pageScript('t1'), firstScript('t1', 'MK')]);
  assert.ok(firstScript('t1', 'MK').startsWith(pageScript('t1')) && firstScript('t1', 'MK').includes(`${JSON.stringify(DOC_KEY)}].first("MK")`));
  // After they came, and with none coming.
  assert.deepEqual([await placing.opened(first), await placing.opened(second), await placing.opened(popup), await placing.opened(null)], [true, true, false, false]);
  placing.restore();
  assert.equal(context.newPage, original);
  // A context whose newPage is its prototype's gets the prototype's back.
  const proto = { newPage: original };
  const inherited = Object.create(proto);
  placePages(inherited, 'MK').restore();
  assert.equal(Object.prototype.hasOwnProperty.call(inherited, 'newPage'), false);
  assert.equal(inherited.newPage, original);
});

test('newPage comes only once its page\'s first document is named, and a first document that cannot be named fails newPage', async () => {
  // A page whose first document runs the script only when the row says: the
  // test's next call to the page may not wait on the browser's own order.
  const fakePage = () => {
    const page = { scripts: [], ran: null, addInitScript: async (s) => { page.scripts.push(s.content); } };
    page.evaluate = (s) => new Promise((resolve, reject) => { page.ran = { resolve: () => { page.scripts.push(s); resolve(); }, reject }; });
    return page;
  };
  const named = fakePage(), lost = fakePage();
  const pages = [named, lost];
  const context = { newPage: async () => pages.shift() };
  const placing = placePages(context, 'MK');
  let came = false;
  const a = context.newPage().then((p) => { came = true; return p; });
  while (!named.ran) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(came, false, 'newPage came before its first document was named');
  named.ran.resolve();
  assert.equal(await a, named);
  assert.deepEqual(named.scripts, [pageScript('t0'), firstScript('t0', 'MK')]);
  const b = context.newPage();
  while (!lost.ran) await new Promise((r) => setImmediate(r));
  lost.ran.reject(new Error('Target page, context or browser has been closed'));
  await assert.rejects(b, /has been closed/);
  placing.restore();
});

test('newPage comes only once the script that names its page\'s later documents is in place, and one the page refuses fails newPage', async () => {
  // A page that takes the script for its later documents only when the row
  // says: the test's next goto may not wait on the browser's own order.
  const fakePage = () => {
    const page = { scripts: [], added: null, evaluate: async (s) => { page.scripts.push(s); } };
    page.addInitScript = (s) => new Promise((resolve, reject) => { page.added = { resolve: () => { page.scripts.push(s.content); resolve(); }, reject }; });
    return page;
  };
  const named = fakePage(), refused = fakePage();
  const pages = [named, refused];
  const context = { newPage: async () => pages.shift() };
  const placing = placePages(context, 'MK');
  let came = false;
  const a = context.newPage().then((p) => { came = true; return p; });
  while (!named.added) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(came, false, 'newPage came before its later documents\' script was in place');
  named.added.resolve();
  assert.equal(await a, named);
  assert.deepEqual(named.scripts, [pageScript('t0'), firstScript('t0', 'MK')]);
  const b = context.newPage();
  while (!refused.added) await new Promise((r) => setImmediate(r));
  refused.added.reject(new Error('Target page, context or browser has been closed'));
  await assert.rejects(b, /has been closed/);
  assert.deepEqual(refused.scripts, []);
  placing.restore();
});

// A frame element of a document the row makes: its tag, its src (null for
// none), whether it has srcdoc, the shadow root it hosts, the frame
// elements under it, and whether it has element children (inner; it has
// when kids has a frame). Reading its window counts in reads: the
// numbering never reads one (in Chromium that begins the frame's first
// document). Each query for frames under it counts in queries.
let reads = 0;
let queries = 0;
const el = (localName, src = null, { srcdoc = false, shadow = null, kids = [], inner = kids.length > 0 } = {}) => ({
  localName, shadowRoot: shadow,
  firstElementChild: inner ? (kids[0] ?? { localName: 'span' }) : null,
  get contentWindow() { reads++; return null; },
  getAttribute: (n) => (n === 'src' ? src : null),
  hasAttribute: (n) => n === 'srcdoc' && srcdoc,
  querySelector: (q) => { queries++; assert.equal(q, 'iframe,frame'); return kids[0] ?? null; },
  querySelectorAll: (q) => { queries++; assert.equal(q, 'iframe,frame'); return kids; },
});
// A document (or shadow root) whose elements, in tree order, are els; walks
// counts its walks.
const tree = (els, baseURI = 'https://h/host') => {
  const t = { baseURI, walks: 0, querySelectorAll: (q) => { assert.equal(q, '*'); t.walks++; return els; } };
  return t;
};
// The seeding state of a document whose elements are those of doc: what
// its frames' documents ask it, and the observer it watches doc with (a
// fake one, when observe is true).
function parentOf(doc, observe = false) {
  const fake = observe ? `globalThis.__mos = []; globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.pending = []; this.asked = null; __mos.push(this); }
    observe(t, o) { this.asked = [t, o]; }
    takeRecords() { const r = this.pending; this.pending = []; return r; }
  };\n` : '';
  const d = documentAt(fake + initScript(S1), '/host', new Map(), 't0', { doc });
  const api = d.run(`globalThis[${JSON.stringify(DOC_KEY)}]`);
  return { enter: (e, w, p) => { try { return [...api.enter(e, w, p)]; } catch (x) { return String(x); } }, mo: observe ? d.ctx.__mos[0] : null };
}
const added = (...n) => ({ addedNodes: n, removedNodes: [] });
const removed = (...n) => ({ addedNodes: [], removedNodes: n });

test('a document numbers its frame elements at the path each asks for, in element order, whatever order their documents begin in, never reading a frame\'s window, and counts each place\'s loads', () => {
  reads = 0;
  const w = (n) => ({ n });
  const E = {
    r0: el('iframe', '/fr?n=0'), sh: el('iframe', '/fr'), a: el('iframe', '/fa'), r1: el('iframe', 'https://cdn.example/fr#x'),
    sd: el('iframe', '/ignored', { srcdoc: true }), none: el('iframe'), empty: el('iframe', ''), blob: el('iframe', 'blob:https://h/5d3c'),
    data: el('iframe', 'data:text/html,<p>'), other: el('iframe', 'mailto:x'), bad: el('iframe', 'http://['), fr: el('frame', '/fb'),
    emb: el('embed', '/fa'), closed: el('iframe', '/fr'), gone: el('iframe', '/fr'),
  };
  const W = Object.fromEntries(Object.keys(E).map((k, i) => [k, w(i)]));
  const els = [
    E.r0, el('div', null, { shadow: tree([E.sh]) }), E.a, E.r1, E.sd, E.none, E.empty, E.blob,
    E.data, E.other, E.bad, E.fr, E.emb,
  ];
  const doc = tree(els);
  const p = parentOf(doc);
  const d = { enter: (x, at) => p.enter(E[x], W[x], at) };
  // r1's document begins first: still the second at /fr, after r0, and
  // after sh, in the shadow root of the element before a.
  assert.deepEqual(d.enter('r1', '/fr'), ['f/fr\n2', 0]);
  assert.deepEqual(d.enter('sh', '/fr'), ['f/fr\n1', 0]);
  assert.deepEqual(d.enter('r0', '/fr'), ['f/fr\n0', 0]);
  // Numbered once: a numbered frame's document begins with no walk.
  assert.equal(doc.walks, 1);
  // Each place counts the documents of each path it loads.
  assert.deepEqual(d.enter('r1', '/fr'), ['f/fr\n2', 1]);
  assert.deepEqual(d.enter('r1', '/fb'), ['f/fr\n2', 0]);
  assert.deepEqual(d.enter('r0', '/fr'), ['f/fr\n0', 1]);
  assert.deepEqual(d.enter('a', '/fa'), ['f/fa\n0', 0]);
  // srcdoc, no src, an empty src, other schemes (by scheme alone: a blob:
  // URL carries a browser-made ID), a src keploy cannot read, a frameset's
  // frame.
  for (const [x, at] of [['sd', 'about:srcdoc\n0'], ['none', 'about:blank\n0'], ['empty', 'about:blank\n1'], ['blob', 'blob:\n0'], ['data', 'data:\n0'], ['other', 'mailto:\n0'], ['bad', '?\n0'], ['fr', '/fb\n0']]) {
    assert.deepEqual(d.enter(x, 'p'), [`f${at}`, 0], at);
  }
  assert.equal(doc.walks, 1);
  // An element the document does not list as a frame (an embed, one in a
  // closed shadow root, a removed one), and no element, have no place.
  for (const x of ['emb', 'closed', 'gone']) assert.deepEqual(d.enter(x, '/fa'), [null, 0]);
  assert.deepEqual(p.enter(null, w(99), '/fa'), [null, 0]);
  // a removed, and a2 put in at its path: a2 takes the next number there;
  // a keeps its place.
  const a2 = el('iframe', '/fa');
  els.splice(2, 1, a2);
  assert.deepEqual(p.enter(a2, w(100), '/fa'), ['f/fa\n1', 0]);
  assert.deepEqual(d.enter('a', '/fa'), ['f/fa\n0', 1]);
  // a2's element now holds another window (put back where no observer
  // sees it): the next number at its path, which that window keeps.
  const again = w(101);
  assert.deepEqual(p.enter(a2, again, '/fa'), ['f/fa\n2', 0]);
  assert.deepEqual(p.enter(a2, again, '/fa'), ['f/fa\n2', 1]);
  // Put in another order, the same frames take the same places.
  const [b, x, s0, s1] = [el('iframe', '/fb'), el('iframe', '/fx'), el('iframe', '/fr'), el('iframe', '/fr')];
  const e2 = parentOf(tree([b, x, s0, s1]));
  assert.deepEqual(e2.enter(s1, w(1), '/fr'), ['f/fr\n1', 0]);
  assert.deepEqual(e2.enter(b, w(2), '/fb'), ['f/fb\n0', 0]);
  assert.equal(reads, 0);
});

test('a document looks into the nodes taken out of it only while it holds a numbered frame, counted exactly', () => {
  const w = (n) => ({ n });
  const els = [];
  const doc = tree(els);
  const p = parentOf(doc, true);
  const row = el('div', null, { inner: true });
  const look = () => { queries = 0; p.mo.cb([removed(row)]); return queries; };
  // a numbered, then c put in and taken out in one change (never
  // numbered), then a taken out: the document holds none, and looks no more.
  const a = el('iframe', '/fa');
  els.push(a);
  p.mo.cb([added(a)]);
  assert.equal(look(), 1);
  // A node that is no frame and has no element child is not looked into.
  queries = 0;
  p.mo.cb([removed(el('span'), { nodeName: '#text' })]);
  assert.equal(queries, 0);
  const c = el('iframe', '/fa');
  p.mo.cb([added(c), removed(c)]);
  assert.equal(look(), 1);
  // A div holding c (never numbered) taken out does not count a off.
  p.mo.cb([removed(el('div', null, { kids: [c] }))]);
  assert.equal(look(), 1);
  els.splice(els.indexOf(a), 1);
  p.mo.cb([removed(a)]);
  assert.equal(look(), 0);
  // Put back, a takes the next number, and is looked for again.
  els.push(a);
  p.mo.cb([added(a)]);
  assert.deepEqual(p.enter(a, w(1), '/fa'), ['f/fa\n1', 0]);
  assert.equal(look(), 1);
});

test('one change that puts a frame in and then takes a numbered one out forgets the one taken out: its document, beginning after, has no place, and put back, it takes the next number', () => {
  const w = (n) => ({ n });
  const els = [];
  const doc = tree(els);
  const p = parentOf(doc, true);
  // f is numbered as it is put in; its document has not begun.
  const f = el('iframe', '/fa');
  els.push(f);
  p.mo.cb([added(f)]);
  // One change: g put in, then f taken out.
  const g = el('iframe', '/fb');
  els.splice(0, 1, g);
  p.mo.cb([added(g), removed(f)]);
  assert.deepEqual(p.enter(f, w(0), '/fa'), [null, 0]);
  assert.deepEqual(p.enter(g, w(1), '/fb'), ['f/fb\n0', 0]);
  // f put back: the next number at /fa.
  els.push(f);
  p.mo.cb([added(f)]);
  assert.deepEqual(p.enter(f, w(2), '/fa'), ['f/fa\n1', 0]);
});

test('a document\'s observer numbers its frames as the app puts them in, only when a change puts one in, forgets a frame taken out, and is read up to date as a frame\'s document begins', () => {
  reads = 0;
  const w = (n) => ({ n });
  const els = [];
  const doc = tree(els);
  const p = parentOf(doc, true);
  assert.equal(p.mo.asked[0], doc);
  assert.deepEqual({ ...p.mo.asked[1] }, { childList: true, subtree: true });
  // A change that puts in, or takes out, no frame costs no walk. A text
  // node or an element with no element child costs no query; one with
  // element children, one; and while the document holds no numbered frame,
  // a node taken out is not looked into.
  const span = el('span');
  const row = el('div', null, { inner: true });
  els.push(span, row);
  queries = 0;
  p.mo.cb([added(span, { nodeName: '#text' }, row), removed(span), removed(row)]);
  assert.equal(doc.walks, 0);
  assert.equal(queries, 1);
  // b0 put in, then b1 before it: numbered as they come, whatever order
  // their documents begin in. A div that holds a frame counts as one.
  // Once a change has put a frame in, the rest of it is not looked into.
  const [b0, b1] = [el('iframe', '/fr'), el('iframe', '/fr')];
  els.push(b0);
  queries = 0;
  p.mo.cb([added(b0, row), added(row)]);
  assert.equal(queries, 0);
  const box = el('div', null, { kids: [b1] });
  els.unshift(box, b1);
  p.mo.cb([added(box)]);
  assert.equal(doc.walks, 2);
  assert.deepEqual(p.enter(b1, w(1), '/fr'), ['f/fr\n1', 0]);
  assert.deepEqual(p.enter(b0, w(0), '/fr'), ['f/fr\n0', 0]);
  assert.equal(doc.walks, 2);
  // b0 taken out and put back after b1: it holds another window, and takes
  // the next number as it is put back. A div taken out forgets its frames.
  p.mo.cb([removed(b0), added(b0)]);
  assert.deepEqual(p.enter(b0, w(2), '/fr'), ['f/fr\n2', 0]);
  els.splice(els.indexOf(box), 1);
  p.mo.cb([removed(box)]);
  els.splice(els.indexOf(b1), 1);
  assert.deepEqual(p.enter(b1, w(1), '/fr'), [null, 0]);
  // While it holds a numbered frame (b0), a node taken out is looked into.
  queries = 0;
  p.mo.cb([removed(row)]);
  assert.equal(queries, 1);
  // Changes the observer has not yet delivered are read first, in order:
  // y put back and z put in after it, z's document beginning first.
  const [y, z] = [el('iframe', '/fy'), el('iframe', '/fy')];
  els.push(y);
  p.mo.cb([added(y)]);
  assert.deepEqual(p.enter(y, w(3), '/fy'), ['f/fy\n0', 0]);
  els.push(z);
  p.mo.pending = [removed(y), added(y), added(z)];
  assert.deepEqual(p.enter(z, w(4), '/fy'), ['f/fy\n2', 0]);
  assert.deepEqual(p.enter(y, w(5), '/fy'), ['f/fy\n1', 0]);
  assert.equal(p.mo.pending.length, 0);
  assert.equal(reads, 0);
});

test('a frame of its parent\'s origin draws in its parent document\'s key and its place there; one under a parent of another origin, in its page by its path, and never with no session storage; one with no place draws its own and says why', () => {
  const at = 'http://h/f';
  // Placed by its parent: the parent's key, its place, its own path and
  // its loads in that place; session storage untouched.
  // It names itself by its element, read through the window's own getter
  // as the script began: a page script that later puts another frameElement
  // on the window does not move it, when a document that ran no init
  // script takes the window over.
  const asked = [];
  const mine = { tag: 'its element' };
  const parent = { [DOC_KEY]: { enter: (e, w, p) => { asked.push([e, p]); return ['f/f\n3', 2]; }, key: () => 'K\n', why: () => 'unused', above: () => 0 } };
  const store = new Map();
  const placed = documentAt(initScript(S1), '/f', store, null, { parent, element: mine, doc: { querySelectorAll: () => [] } });
  assert.deepEqual(placed.draws(), documentAt(initScript(S1), '/f', new Map([[LOADS_KEY, '{"/f":2}']]), 'K\nf/f\n3').draws());
  placed.run('Object.defineProperty(globalThis, "frameElement", { value: { tag: "the page\'s" }, configurable: true });');
  placed.ctx.document = { querySelectorAll: () => [] };
  placed.draws();
  assert.deepEqual(asked, [[mine, '/f'], [mine, '/f']]);
  assert.equal(store.size, 0);
  // A frameElement that is no getter: no element, so no place.
  const plain = [];
  const p2 = { [DOC_KEY]: { enter: (e, w, p) => { plain.push(e); return [null, 0]; }, key: () => 'K\n', why: () => '', above: () => 0 } };
  const d2 = documentAt(initScript(S1), '/f', new Map(), null, { parent: p2 });
  d2.ctx.frameElement = mine;
  d2.run(initScript(S1));
  assert.deepEqual(plain, [undefined, mine]);
  // Under a parent of another origin: its page, marked, its path, and its
  // origin's count in the tab.
  const tab = new Map([[LOADS_KEY, '{"/f":1}']]);
  assert.deepEqual(documentAt(initScript(S1), '/f', tab, 't0', { parent: OTHER }).draws(), documentAt(initScript(S1), '/f', new Map([[LOADS_KEY, '{"/f":1}']]), 't0x').draws());
  assert.equal(tab.get(LOADS_KEY), '{"/f":2}');
  // In a page no page script names, it has no place, and says so with no
  // reason of its own, with session storage or without.
  for (const st of [new Map(), null]) {
    const none = [];
    const u = documentAt(initScript(S1, 'rep'), '/f', st, null, { parent: OTHER, report: 'rep', told: none, frames: 3 });
    assert.notDeepEqual(u.draws(), u.draws());
    assert.deepEqual(none, [at]);
  }
  // With no session storage to count its loads in, it is never seeded,
  // alone under its parent or not: nothing tells its next document (a
  // reload, a frame put in again at its place) from it. It draws its own
  // and says it is that frame (0 frames up: the fixture counts the frames
  // beside it, othersBeside), whatever its parent's length says. With
  // session storage, it is seeded, whatever its parent holds.
  assert.deepEqual(documentAt(initScript(S1), '/f', new Map(), 't0', { parent: OTHER, frames: 4 }).draws(), documentAt(initScript(S1), '/f', new Map(), 't0x').draws());
  for (const frames of [1, 2, 5, undefined, 'x']) {
    const told = [];
    const t = documentAt(initScript(S1, 'rep'), '/f', null, 't0', { parent: OTHER, frames, report: 'rep', told });
    const drew = t.draws();
    assert.notDeepEqual(drew, t.draws(), String(frames));
    assert.notDeepEqual(drew, documentAt(initScript(S1), '/f', new Map(), 't0x').draws(), String(frames));
    assert.deepEqual(told, [[at, 'uncounted', 0]], String(frames));
  }
  // The parent is the one the document began with: a page script that
  // replaces the global parent (var parent = 0, parent = self, a parent of
  // its own making) before the first draw moves neither the rule nor what
  // it tells.
  for (const swap of ['var parent = 0;', 'parent = globalThis;', 'parent = { length: 1 };', 'parent = { get length() { throw new Error(); } };']) {
    const told = [];
    const t = documentAt(initScript(S1, 'rep'), '/f', null, 't0', { parent: OTHER, frames: 3, report: 'rep', told });
    t.run(swap);
    const drew = t.draws();
    assert.notDeepEqual(drew, t.draws(), swap);
    assert.deepEqual(told, [[at, 'uncounted', 0]], swap);
  }
  // A frame its parent cannot place, one whose parent is gone, and one
  // whose parent has no seeding state: no place, the frame reason.
  for (const p of [{ [DOC_KEY]: { enter: () => [null, 0], key: () => 'K\n', why: () => '', above: () => 0 } }, null, {}]) {
    const told = [];
    const f = documentAt(initScript(S1, 'rep'), '/f', new Map(), 't0', { parent: p, report: 'rep', told });
    let drew = [];
    try { drew = [f.draws(), f.draws()]; } catch (e) { drew = [String(e)]; }
    assert.deepEqual(told, [[at, 'frame']]);
    assert.notDeepEqual(drew[0], drew[1]);
  }
  // A frame placed in a parent with no place: no place, its parent's
  // reason; for 'uncounted', one frame further up than its parent's.
  for (const why of ['', 'frame', 'uncounted', 'nostorage']) {
    const told = [];
    documentAt(initScript(S1, 'rep'), '/f', new Map(), 't0', { parent: { [DOC_KEY]: { enter: () => ['f/f\n0', 0], key: () => null, why: () => why, above: () => 3 } }, report: 'rep', told }).draws();
    assert.deepEqual(told, [why === 'uncounted' ? [at, why, 4] : why ? [at, why] : at], why);
  }
});

test('a document that a second run of the script takes over (WebKit runs it in a document that takes over its window\'s first about:blank) begins once: the first run passes on the browser\'s own', () => {
  const store = new Map();
  const blank = { baseURI: 'about:blank', querySelectorAll: () => [] };
  // The window's first about:blank runs the script; a window.open of its
  // own is there to be wrapped.
  const d = documentAt(`globalThis.open = function () { return {}; };\n${initScript(S1)}`, 'blank', store, 't0', { doc: blank });
  // Its document is taken over by /p, which runs the script again.
  d.ctx.document = { baseURI: 'http://h/p', querySelectorAll: () => [] };
  d.ctx.location.pathname = '/p';
  d.run(initScript(S1));
  d.run(pageScript('t0'));
  // getRandomValues and randomUUID call the first run's functions first,
  // and a popup goes through its window.open: /p is still counted once.
  const drew = d.draws();
  d.run('open()');
  assert.equal(store.get(LOADS_KEY), '{"blank":1,"/p":1}');
  assert.deepEqual(drew, documentAt(initScript(S1), '/p', new Map(), 't0').draws());
});

test('a Web Worker started in a document that a second run of the script took over is marked once, by that run, as at a document with no takeover; the first run passes it on as asked and names nothing', () => {
  const made = [];
  class Worker { constructor(url) { made.push(String(url)); } }
  const told = [];
  const blank = { baseURI: 'about:blank', querySelectorAll: () => [] };
  const d = documentAt(initScript(S1, 'tell'), 'blank', new Map(), 't0', { doc: blank, report: 'tell', told, globals: { URL, Worker } });
  d.ctx.document = { baseURI: 'http://h/p', querySelectorAll: () => [] };
  d.ctx.location.pathname = '/p';
  d.run(initScript(S1, 'tell'));
  d.run(pageScript('t0'));
  d.run('new Worker("/w.js")');
  assert.equal(made.length, 1);
  assert.equal(made[0].split(`${WORKER_PARAM}=`).length, 2, made[0]);
  assert.equal(workerMark(made[0]).url, 'http://h/w.js');
  const plain = [];
  class Plain { constructor(url) { plain.push(String(url)); } }
  documentAt(initScript(S1), '/p', new Map(), 't0', { globals: { URL, Worker: Plain } }).run('new Worker("/w.js")');
  assert.deepEqual(made, plain);
  assert.deepEqual(told, []);
});

// Workers: the page's Worker and SharedWorker mark the script URL with the
// worker's token; the route answers the marked script with the worker's
// seeding, then the app's own script.
const TOKEN = /^[0-9a-f]{32}$/;
const workerGlobals = () => {
  const made = [];
  class Worker { constructor(url, opts) { made.push([String(url), opts]); } }
  class SharedWorker { constructor(url, opts) { made.push([String(url), opts]); } }
  return { made, globals: { URL, Worker, SharedWorker } };
};

test('a worker\'s mark: what markWorker makes, workerMark reads back, the URL as the app asked for it, query and fragment kept; any other URL has none', () => {
  const t = 'ab'.repeat(16);
  for (const url of ['http://h/w.js', 'http://h/w.js?a=1', 'http://h/w.js?', 'http://h/w.js#f', 'http://h/w.js?a=1#f?x']) {
    for (const [kind, n] of [['w', -1], ['m', -1], ['s', -1], ['x', -1], ['t', -1], ['p', 0], ['p', 7]]) {
      const m = markWorker(url, kind, t, n);
      assert.ok(new URL(m).searchParams.has(WORKER_PARAM), m);
      assert.deepEqual(workerMark(m), { kind, token: t, n, url }, m);
    }
  }
  assert.equal(markWorker('http://h/w.js?a=1#f', 'w', t), `http://h/w.js?a=1&__keploy_worker=w.${t}#f`);
  for (const u of ['http://h/w.js', `http://h/w.js?__keploy_worker=w.${t}&a=1`, `http://h/w.js?__keploy_worker=z.${t}`, `http://h/w.js?__keploy_worker=w.${t.toUpperCase()}`,
    `http://h/w.js?__keploy_worker=w.${t}.0`, `http://h/w.js?__keploy_worker=t.${t}.0`, `http://h/w.js?__keploy_worker=o.${t}`, `http://h/w.js?__keploy_worker=o.${t}.0`, `http://h/w.js?__keploy_worker=p.${t}`, `http://h/w.js?__keploy_worker=w.${t.slice(1)}`]) {
    assert.equal(workerMark(u), null, u);
  }
});

test('a document\'s Web Worker starts at its script URL marked with its own token: the same each run, another for the next worker at that path, another seed or page; a module worker\'s is marked so; it keeps new, instanceof and its constructor', () => {
  const at = (seed, page, script = '', path = '/p') => {
    const w = workerGlobals();
    const d = documentAt(initScript(seed), path, new Map(), page, { globals: w.globals });
    d.run(script || 'globalThis.a = new Worker("/w.js?q=1#f"); globalThis.b = new Worker("w.js"); globalThis.c = new Worker("/x/m.js", { type: "module" });');
    return { d, made: w.made.map(([u, o]) => [workerMark(u), o === undefined ? undefined : JSON.parse(JSON.stringify(o))]) };
  };
  const { d, made } = at(S1, 't0');
  assert.deepEqual(made.map(([m]) => [m.kind, m.url, m.n]), [['w', 'http://h/w.js?q=1#f', -1], ['w', 'http://h/w.js', -1], ['m', 'http://h/x/m.js', -1]]);
  assert.deepEqual(made[2][1], { type: 'module' });
  for (const [m] of made) assert.match(m.token, TOKEN);
  assert.equal(new Set(made.map(([m]) => m.token)).size, 3);
  assert.deepEqual(at(S1, 't0').made, made);
  assert.notEqual(at(S2, 't0').made[0][0].token, made[0][0].token);
  assert.notEqual(at(S1, 't1').made[0][0].token, made[0][0].token);
  assert.equal(d.run('a instanceof Worker && Worker.prototype.constructor === Worker && Worker.name === "Worker" && Worker.length === 1'), true);
  assert.throws(() => d.run('Worker("/w.js")'), TypeError);
});

test('a worker keploy cannot mark starts as the app asked and is named once with why; one of a document with no place starts as asked, the document named', () => {
  const told = [];
  const w = workerGlobals();
  const d = documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told, globals: w.globals });
  d.run('new Worker("blob:http://h/0f0e"); new Worker("data:text/javascript,1"); new Worker("blob:http://h/0f0e");');
  assert.deepEqual(w.made.map(([u]) => u), ['blob:http://h/0f0e', 'data:text/javascript,1', 'blob:http://h/0f0e']);
  assert.deepEqual(told, [['blob:', 'worker'], ['data:', 'worker'], ['blob:', 'worker']]);
  // A URL the browser cannot read: the browser's own error, nothing named.
  const told1 = [];
  class Strict { constructor(url) { if (String(url) === 'http://[') throw new SyntaxError('the browser\'s own'); } }
  const d1 = documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told: told1, globals: { URL, Worker: Strict } });
  assert.throws(() => d1.run('new Worker("http://[")'), (e) => e.message === 'the browser\'s own');
  assert.deepEqual(told1, []);
  // The browser refuses the marked URL (a Trusted Types policy): as asked.
  const told2 = [];
  const made = [];
  class Picky { constructor(url) { if (workerMark(String(url)) !== null) throw new TypeError('refused'); made.push(String(url)); } }
  documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told: told2, globals: { URL, Worker: Picky } }).run('new Worker("/w.js")');
  assert.deepEqual([made, told2], [["/w.js"], [['http://h/w.js', 'worker']]]);
  // No page names the document: its worker is not marked, the document is named.
  const told3 = [];
  const w3 = workerGlobals();
  documentAt(initScript(S1, 'tell'), '/p', new Map(), null, { report: 'tell', told: told3, globals: w3.globals }).run('new Worker("/w.js")');
  assert.deepEqual([w3.made.map(([u]) => u), told3], [['/w.js'], ['http://h/p']]);
});

test('a Shared Worker\'s token is the same in every document of the test, by script path and name, so its documents still share it; where the route cannot reach it (shared: false) it starts as asked and is named', () => {
  const tokens = (seed, page, path, script, shared = true, told = []) => {
    const w = workerGlobals();
    documentAt(initScript(seed, 'tell', '', shared), path, new Map(), page, { report: 'tell', told, globals: w.globals }).run(script);
    return w.made.map(([u, o]) => [workerMark(u), o === undefined ? undefined : JSON.parse(JSON.stringify(o))]);
  };
  const s = 'new SharedWorker("/s.js"); new SharedWorker("/s.js", "n"); new SharedWorker("/s.js", { name: "n", type: "module" }); new SharedWorker("/t.js");';
  const a = tokens(S1, 't0', '/p', s);
  assert.deepEqual(a.map(([m]) => m.kind), ['s', 's', 'x', 's']);
  assert.deepEqual(tokens(S1, 't1', '/q', s), a);
  assert.equal(a[1][0].token, a[2][0].token);
  assert.equal(new Set([a[0], a[1], a[3]].map(([m]) => m.token)).size, 3);
  assert.notEqual(tokens(S2, 't0', '/p', s)[0][0].token, a[0][0].token);
  const told = [];
  const off = tokens(S1, 't0', '/p', 'new SharedWorker("/s.js")', false, told);
  assert.deepEqual([off, told], [[[null, undefined]], [['http://h/s.js', 'shared']]]);
});

// What a line for a worker keploy cannot reach says of the workers it starts.
const KIDS = 'and so does each worker it starts, so their draws may differ at replay: ';

test('the lines for a Service Worker and a worker one may answer say what it is, why, and the next step', () => {
  const block = 'if the tests do not need it, set serviceWorkers: \'block\' in the project\'s use (Playwright then registers none, and keploy seeds the workers it would have answered).';
  assert.equal(unplacedLine('t', 'http://h/sw.js', 'service'), 'keploy: in t, the Service Worker at http://h/sw.js draws the browser\'s own random numbers, so its draws may differ at replay: ' +
    'keploy cannot put its seeding ahead of a Service Worker\'s script, and a worker whose script the Service Worker may answer starts unseeded (each one is named); ' + block);
  assert.equal(unplacedLine('t', 'http://h/w.js', 'controlled', 0, 'http://h/sw.js'), 'keploy: in t, the worker at http://h/w.js draws the browser\'s own random numbers, ' + KIDS +
    'a Service Worker (at http://h/sw.js) may answer the worker\'s script, and it would see keploy\'s __keploy_worker mark in the script\'s URL, so keploy starts the worker as the app asked; ' + block);
  assert.equal(unplacedLine('t', 'http://h/w.js', 'controlled'), 'keploy: in t, the worker at http://h/w.js draws the browser\'s own random numbers, ' + KIDS +
    'a Service Worker may answer the worker\'s script, and it would see keploy\'s __keploy_worker mark in the script\'s URL, so keploy starts the worker as the app asked; ' + block);
});

test('the lines for a worker keploy cannot reach say what it is, that each worker it starts is unseeded too, why, and the next step', () => {
  assert.equal(unplacedLine('t', 'blob:', 'worker'), 'keploy: in t, the worker at blob: draws the browser\'s own random numbers, ' + KIDS +
    'it is a worker started from a script keploy cannot mark (a blob: or data: URL, or a URL the browser refused with keploy\'s mark, as a Trusted Types policy may), ' +
    'so keploy cannot put its seeding ahead of the script; start it from the script\'s http(s) URL to seed it.');
  assert.equal(unplacedLine('t', 'http://h/s.js', 'shared'), 'keploy: in t, the Shared Worker at http://h/s.js draws the browser\'s own random numbers, ' + KIDS +
    'it is a Shared Worker, and Firefox does not let keploy reach a Shared Worker\'s script to put its seeding ahead of it; ' +
    'record and replay the test in Chromium or WebKit to seed it.');
  assert.equal(unplacedLine('t', 'http://h/b.js', 'nested'), 'keploy: in t, the worker at http://h/b.js draws the browser\'s own random numbers, ' + KIDS +
    'it is a worker that a worker started, and Chromium and Firefox do not let keploy reach its script to put its seeding ahead of it; record and replay the test in WebKit to seed it.');
  assert.equal(unplacedLine('t', 'http://h/s.js', 'early'), 'keploy: in t, the Shared Worker at http://h/s.js draws the browser\'s own random numbers, ' + KIDS +
    'it is a Shared Worker started before the browser told keploy which Service Workers the page\'s origin has (keploy asks as each document begins, ' +
    'and a document that begins while a document of the origin is registering a Service Worker, or that cannot read its Service Workers ' +
    'or its Web Locks, as a sandboxed one, is never told), and a Service Worker whose scope holds the worker\'s URL ' +
    'would see keploy\'s __keploy_worker mark in the script\'s URL, so keploy starts the worker as the app asked; if the tests do not need it, ' +
    'set serviceWorkers: \'block\' in the project\'s use (Playwright then registers none, and keploy seeds the workers it would have answered).');
  assert.match(unplacedLine('t', 'http://h/w.js', 'routed'),/^keploy: in t, the worker at http:\/\/h\/w\.js draws the browser's own random numbers, and so does each worker it starts, so their draws may differ at replay: a route of the test's own /);
});


// An origin's Web Locks, as the browser's LockManager: request takes the
// lock at once (none here waits on another), holds it until the callback's
// promise settles and answers that; query answers what is held, and pending
// is what the row puts there. asked keeps each request, and log each
// request, query and release in order.
const lockManager = () => {
  const held = [];
  const pending = [];
  const asked = [];
  const log = [];
  const locks = {
    request(name, options, cb) {
      if (typeof options === 'function') { cb = options; options = {}; }
      const l = { name, mode: options.mode ?? 'exclusive' };
      held.push(l); asked.push(l); log.push(['request', l.name, l.mode]);
      return Promise.resolve().then(() => cb(l)).finally(() => { held.splice(held.indexOf(l), 1); log.push(['release', l.name]); });
    },
    query() { log.push(['query', held.length]); return Promise.resolve({ held: held.map((l) => ({ ...l })), pending: pending.map((l) => ({ ...l })) }); },
  };
  return { locks, held, pending, asked, log };
};

// A document's ServiceWorkerContainer: register answers what answer gives
// (a registration of its script, by default), getRegistrations the
// registrations regs, and the controller is state.controller; its navigator's
// Web Locks are locks (a manager of its own by default; null: none).
const swGlobals = ({ answer = (u) => Promise.resolve({ active: { scriptURL: `http://h${u}` } }), regs = [], late = false, state = { controller: null }, locks = lockManager(), log = [] } = {}) => {
  class ServiceWorkerContainer {
    register(u) { return answer(u); }
    // late: the registrations come 20 ms after.
    getRegistrations() { log.push('getRegistrations'); return late ? new Promise((r) => setTimeout(() => r(regs), 20)) : Promise.resolve(regs); }
    get controller() { return state.controller; }
  }
  const navigator = { serviceWorker: new ServiceWorkerContainer() };
  if (locks !== null) navigator.locks = locks.locks;
  return { state, locks, globals: { ServiceWorkerContainer, navigator } };
};
const turn = () => new Promise((r) => setImmediate(r));

test('a Service Worker a document registers is named once the browser registers it, at its script\'s address; one Playwright blocks (serviceWorkers: \'block\'), or a refused one, is not; register answers as the browser\'s does', async () => {
  const run = async (sw, script) => {
    const told = [];
    const d = documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told, globals: { URL, ...sw.globals } });
    const v = await d.run(script);
    await turn();
    return { told, v };
  };
  const a = await run(swGlobals(), 'navigator.serviceWorker.register("/sw.js?v=2", { scope: "/" })');
  assert.deepEqual(a.told, [['http://h/sw.js', 'service']]);
  assert.deepEqual(a.v, { active: { scriptURL: 'http://h/sw.js?v=2' } });
  // Playwright's block: register answers no registration.
  const blocked = swGlobals();
  blocked.globals.ServiceWorkerContainer.prototype.register = async () => undefined;
  assert.deepEqual((await run(blocked, 'navigator.serviceWorker.register("/sw.js")')).told, []);
  // A refused registration rejects as the browser's does, and is not named.
  const refused = swGlobals({ answer: () => Promise.reject(new TypeError('the browser\'s own')) });
  await assert.rejects(run(refused, 'navigator.serviceWorker.register("/sw.js")'), (e) => e.message === 'the browser\'s own');
  // A container with no register keeps none.
  const none = swGlobals();
  delete none.globals.ServiceWorkerContainer.prototype.register;
  assert.equal((await run(none, 'typeof navigator.serviceWorker.register')).v, 'undefined');
  // Without the fixture's function: registered, nothing said.
  const quiet = swGlobals();
  const d = documentAt(initScript(S1), '/p', new Map(), 't0', { globals: { URL, ...quiet.globals } });
  assert.deepEqual(await d.run('navigator.serviceWorker.register("/sw.js")'), { active: { scriptURL: 'http://h/sw.js' } });
});

test('a worker whose script a Service Worker may answer starts as the app asked, unmarked, and is named with that Service Worker: a Web Worker of a controlled document, a Shared Worker of a document that is controlled, or whose URL the scope of a registration it made or found as it began holds; the next worker at its path keeps its place', async () => {
  const run = async (sw, script, before = '') => {
    const told = [];
    const w = workerGlobals();
    const d = documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told, globals: { ...w.globals, ...sw.globals } });
    await turn();
    if (before) { await d.run(before); await turn(); }
    d.run(script);
    return { told, made: w.made.map(([u]) => [u, workerMark(u)]) };
  };
  // Controlled: neither kind is marked, each is named with the controller.
  const c = swGlobals({ state: { controller: { scriptURL: 'http://h/sw.js?v=1' } } });
  const a = await run(c, 'new Worker("/w.js"); new SharedWorker("/s.js"); new Worker("/w.js");');
  assert.deepEqual(a.made.map(([u, m]) => [u, m]), [['/w.js', null], ['/s.js', null], ['/w.js', null]]);
  assert.deepEqual(a.told, [['http://h/w.js', 'controlled', 'http://h/sw.js'], ['http://h/s.js', 'controlled', 'http://h/sw.js'], ['http://h/w.js', 'controlled', 'http://h/sw.js']]);
  // Registered by this document but not its controller: its Web Worker is
  // marked (its script goes to the network), its Shared Worker is not.
  const r = await run(swGlobals(), 'new Worker("/w.js"); new SharedWorker("/s.js");', 'navigator.serviceWorker.register("/sw.js")');
  assert.equal(r.made[0][1].kind, 'w');
  assert.deepEqual(r.made[1], ['/s.js', null]);
  assert.deepEqual(r.told, [['http://h/sw.js', 'service'], ['http://h/s.js', 'controlled', 'http://h/sw.js']]);
  // A registration of its origin found as the document began.
  const f = await run(swGlobals({ regs: [{ scope: 'http://h/', active: null, waiting: null, installing: { scriptURL: 'http://h/old.js?x' } }] }), 'new Worker("/w.js"); new SharedWorker("/s.js");');
  assert.equal(f.made[0][1].kind, 'w');
  assert.deepEqual([f.made[1], f.told], [['/s.js', null], [['http://h/s.js', 'controlled', 'http://h/old.js']]]);
  // A registration found is named by its active Service Worker, else its
  // waiting one, else its installing one.
  const sws = { a: { scriptURL: 'http://h/a.js' }, b: { scriptURL: 'http://h/b.js' }, c: { scriptURL: 'http://h/c.js' } };
  for (const [reg, named] of [[{ scope: 'http://h/', active: sws.a, waiting: sws.b, installing: sws.c }, 'http://h/a.js'], [{ scope: 'http://h/', active: null, waiting: sws.b, installing: sws.c }, 'http://h/b.js'], [{ scope: 'http://h/', active: null, waiting: null, installing: sws.c }, 'http://h/c.js']]) {
    assert.deepEqual((await run(swGlobals({ regs: [reg] }), 'new SharedWorker("/s.js");')).told, [['http://h/s.js', 'controlled', named]]);
  }
  // The one this document registered is named, even when one found as
  // the document began comes in after it.
  {
    const told = [];
    const w = workerGlobals();
    const d = documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told, globals: { ...w.globals, ...swGlobals({ regs: [{ scope: 'http://h/', active: sws.a }], late: true }).globals } });
    await d.run('navigator.serviceWorker.register("/sw.js")');
    await new Promise((r) => setTimeout(r, 60));
    d.run('new SharedWorker("/s.js");');
    assert.deepEqual(told, [['http://h/sw.js', 'service'], ['http://h/s.js', 'controlled', 'http://h/sw.js']]);
  }
  // A controller whose script keploy cannot read: named with no address.
  const u = await run(swGlobals({ state: { controller: { scriptURL: 'http://[' } } }), 'new Worker("/w.js");');
  assert.deepEqual([u.made, u.told], [[['/w.js', null]], [['http://h/w.js', 'controlled', '']]]);
  // A worker keploy cannot mark is named for that, controlled or not.
  const b = await run(c, 'new Worker("blob:http://h/0f0e");');
  assert.deepEqual([b.made, b.told], [[['blob:http://h/0f0e', null]], [['blob:', 'worker']]]);
  // None: both are marked, nothing said.
  const n = await run(swGlobals(), 'new Worker("/w.js"); new SharedWorker("/s.js");');
  assert.deepEqual([n.made.map(([, m]) => m.kind), n.told], [['w', 's'], []]);
  // No Service Worker can be read here (an opaque origin's throws).
  const opaque = { globals: { navigator: Object.defineProperty({}, 'serviceWorker', { get() { throw new Error('SecurityError: sandboxed'); } }) } };
  const o = await run(opaque, 'new Worker("/w.js");');
  assert.deepEqual([o.made.map(([, m]) => m.kind), o.told], [['w'], []]);
  // A worker a Service Worker may answer still takes its place at its path:
  // the next one there, once no Service Worker controls the document, is
  // marked as the second at that path, as in a document with none.
  const state = { controller: { scriptURL: 'http://h/sw.js' } };
  const told = [];
  const w = workerGlobals();
  const d = documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told, globals: { ...w.globals, ...swGlobals({ state }).globals } });
  d.run('new Worker("/w.js");');
  state.controller = null;
  d.run('new Worker("/w.js");');
  const plain = await run(swGlobals(), 'new Worker("/w.js"); new Worker("/w.js");');
  assert.deepEqual([workerMark(w.made[0][0]), workerMark(w.made[1][0])], [null, plain.made[1][1]]);
});

// The BroadcastChannels of one browser context: a message reaches each other
// channel of its name, a turn later, as a structured clone.
const channels = () => {
  const all = [];
  // What a handler threw: a page's error event would see it.
  const thrown = [];
  class BroadcastChannel {
    constructor(name) { this.name = String(name); this.onmessage = null; all.push(this); }
    postMessage(m) {
      const d = m === undefined ? undefined : JSON.parse(JSON.stringify(m));
      for (const c of all) {
        if (c !== this && c.name === this.name) setImmediate(() => { try { if (c.onmessage) c.onmessage({ data: d }); } catch (e) { thrown.push(e); } });
      }
    }
  }
  return { BroadcastChannel, all, thrown };
};

test('a Shared Worker is marked only once keploy knows no registration\'s scope holds its URL: one started before the browser answers, or where it never does, starts as the app asked and is named; the longest scope that holds it names its Service Worker; one with no Service Workers, or in a context Playwright blocks, is marked at once', async () => {
  const start = (sw, extra = {}) => {
    const told = [];
    const w = workerGlobals();
    const d = documentAt(initScript(S1, 'tell'), '/p', new Map(), 't0', { report: 'tell', told, globals: { ...w.globals, ...sw.globals, ...extra } });
    return { d, told, made: () => w.made.map(([u]) => [u, workerMark(u)]) };
  };
  // Before the answer: unmarked, named; once it has come with none, the next
  // is marked, and a Web Worker is marked either way.
  const e = start(swGlobals({ late: true }));
  e.d.run('new SharedWorker("/s.js"); new Worker("/w.js");');
  await new Promise((r) => setTimeout(r, 60));
  e.d.run('new SharedWorker("/s.js");');
  assert.deepEqual(e.made().map(([u, m]) => [m ? m.url : u, m && m.kind]), [['/s.js', null], ['http://h/w.js', 'w'], ['http://h/s.js', 's']]);
  assert.deepEqual(e.told, [['http://h/s.js', 'early']]);
  // A browser that never answers (getRegistrations refused), or a document
  // that cannot read its Service Workers: never known.
  const refused = swGlobals();
  refused.globals.ServiceWorkerContainer.prototype.getRegistrations = () => Promise.reject(new Error('SecurityError'));
  const r = start(refused);
  await turn();
  r.d.run('new SharedWorker("/s.js");');
  assert.deepEqual([r.made(), r.told], [[['/s.js', null]], [['http://h/s.js', 'early']]]);
  const o = start({ globals: { navigator: Object.defineProperty({}, 'serviceWorker', { get() { throw new Error('SecurityError: sandboxed'); } }) } });
  await turn();
  o.d.run('new SharedWorker("/s.js");');
  assert.deepEqual([o.made(), o.told], [[['/s.js', null]], [['http://h/s.js', 'early']]]);
  // No Service Workers here (an insecure context): marked at once.
  const n = start({ globals: { navigator: {} } });
  n.d.run('new SharedWorker("/s.js");');
  assert.deepEqual([n.made()[0][1].kind, n.told], ['s', []]);
  // Scopes: one that does not hold the URL leaves it marked; of two that
  // do, the longest names the Service Worker.
  const regs = [{ scope: 'http://h/a/b/', active: { scriptURL: 'http://h/ab.js' } }, { scope: 'http://h/a/', active: { scriptURL: 'http://h/a/sw.js' } }];
  const s = start(swGlobals({ regs }));
  await turn();
  s.d.run('new SharedWorker("/s.js"); new SharedWorker("/a/s.js"); new SharedWorker("/a/b/s.js"); new SharedWorker("/a/bs.js");');
  assert.deepEqual(s.made().map(([u, m]) => [m ? m.url : u, m && m.kind]), [['http://h/s.js', 's'], ['/a/s.js', null], ['/a/b/s.js', null], ['/a/bs.js', null]]);
  assert.deepEqual(s.told, [['http://h/a/s.js', 'controlled', 'http://h/a/sw.js'], ['http://h/a/b/s.js', 'controlled', 'http://h/ab.js'], ['http://h/a/bs.js', 'controlled', 'http://h/a/sw.js']]);
  // A register of this document's own, before the answer, at the scope it
  // names (else its script's directory): known at once.
  const own = start(swGlobals({ late: true }));
  own.d.run('const c = navigator.serviceWorker; c.register("/x/sw.js"); c.register("/sw2.js", { scope: "/y/#f" }); c.register("/v/sw.js", { type: "module" }); c.register("/n/sw.js", null); ' +
    'new SharedWorker("/x/s.js"); new SharedWorker("/y/s.js"); new SharedWorker("/v/s.js"); new SharedWorker("/n/s.js"); new SharedWorker("/z/s.js");');
  assert.deepEqual(own.made().map(([, m]) => m), [null, null, null, null, null]);
  assert.deepEqual(own.told.slice(0, 5), [['http://h/x/s.js', 'controlled', 'http://h/x/sw.js'], ['http://h/y/s.js', 'controlled', 'http://h/sw2.js'],
    ['http://h/v/s.js', 'controlled', 'http://h/v/sw.js'], ['http://h/n/s.js', 'controlled', 'http://h/n/sw.js'], ['http://h/z/s.js', 'early']]);
  // A register at a URL keploy cannot read holds no scope that can hold a worker's URL.
  const bad = start(swGlobals());
  await turn();
  bad.d.run('navigator.serviceWorker.register("http://["); new SharedWorker("/s.js");');
  assert.equal(bad.made()[0][1].kind, 's');
  // Playwright's block (its own register, which registers none): known at
  // once, so marked before the answer; its register says nothing, and its
  // scope is not kept.
  const blocked = swGlobals({ late: true });
  blocked.globals.ServiceWorkerContainer.prototype.register = async () => { void 'Service Worker registration blocked by Playwright'; };
  const b = start(blocked);
  b.d.run('new SharedWorker("/s.js"); navigator.serviceWorker.register("/sw.js");');
  await turn();
  b.d.run('new SharedWorker("/t.js");');
  assert.deepEqual([b.made().map(([, m]) => m.kind), b.told], [['s', 's'], []]);
  // A register that answers none after the browser found a registration
  // at its scope: that one is kept.
  const slow = swGlobals({ late: true, regs: [{ scope: 'http://h/', active: { scriptURL: 'http://h/old.js' } }] });
  slow.globals.ServiceWorkerContainer.prototype.register = () => new Promise((ok) => setTimeout(() => ok(undefined), 40));
  const k = start(slow);
  k.d.run('navigator.serviceWorker.register("/sw.js");');
  await new Promise((r) => setTimeout(r, 80));
  k.d.run('new SharedWorker("/s.js");');
  assert.deepEqual([k.made(), k.told], [[['/s.js', null]], [['http://h/s.js', 'controlled', 'http://h/sw.js']]]);
});

test('the documents of a context say on keploy\'s channel each registration they make or find: another document\'s next Shared Worker that its scope holds starts as the app asked and is named with it; one Playwright\'s block answered with none is taken back, but not one a document found; a message keploy did not make changes nothing', async () => {
  const bus = channels();
  const doc = (sw) => {
    const told = [];
    const w = workerGlobals();
    const d = documentAt(initScript(S1, 'tell', 'm1'), '/p', new Map(), 't0', { report: 'tell', told, globals: { ...w.globals, ...sw.globals, BroadcastChannel: bus.BroadcastChannel } });
    return { d, told, made: () => w.made.map(([u]) => workerMark(u)) };
  };
  const a = doc(swGlobals());
  const b = doc(swGlobals());
  await turn();
  a.d.run('navigator.serviceWorker.register("/app/sw.js");');
  await turn();
  b.d.run('new SharedWorker("/app/s.js"); new SharedWorker("/s.js");');
  assert.deepEqual(b.made().map((m) => m && m.kind), [null, 's']);
  assert.deepEqual(b.told, [['http://h/app/s.js', 'controlled', 'http://h/app/sw.js']]);
  assert.deepEqual(bus.all.map((c) => c.name), [`${SW_CHANNEL}m1`, `${SW_CHANNEL}m1`]);
  // A registration a document finds as it begins is said to the others.
  const c = doc(swGlobals({ regs: [{ scope: 'http://h/f/', active: { scriptURL: 'http://h/f/sw.js' } }] }));
  await turn(); await turn();
  a.d.run('new SharedWorker("/f/s.js");');
  assert.deepEqual(a.told, [['http://h/app/sw.js', 'service'], ['http://h/f/s.js', 'controlled', 'http://h/f/sw.js']]);
  // Playwright's block: a register said, then taken back once it answers
  // none; c keeps the scope it found.
  const blocked = swGlobals();
  blocked.globals.ServiceWorkerContainer.prototype.register = async () => undefined;
  const p = doc(blocked);
  await turn();
  p.d.run('navigator.serviceWorker.register("/q/sw.js"); navigator.serviceWorker.register("/f/sw.js");');
  await turn();
  b.d.run('new SharedWorker("/q/s.js");');
  assert.equal(b.made()[2], null);
  await turn(); await turn();
  b.d.run('new SharedWorker("/q/s.js");');
  c.d.run('new SharedWorker("/f/s.js");');
  assert.equal(b.made()[3].kind, 's');
  assert.deepEqual([c.made(), c.told], [[null], [['http://h/f/s.js', 'controlled', 'http://h/f/sw.js']]]);
  // Another script's messages on the channel, of any other shape, and one
  // at a scope already known: nothing changes, and nothing throws.
  const page = new bus.BroadcastChannel(`${SW_CHANNEL}m1`);
  for (const m of [null, undefined, 1, 'x', { scope: ['http://h/'], at: 'http://h/x.js' }, { scope: 'http://h/', at: 2 }, { scope: 'http://h/app/', gone: 'yes' }, { scope: 'http://h/app/', at: 'http://h/other.js' }]) page.postMessage(m);
  await turn();
  b.d.run('new SharedWorker("/s.js"); new SharedWorker("/app/t.js");');
  assert.deepEqual(b.made().slice(4).map((m) => m && m.kind), ['s', null]);
  assert.deepEqual(b.told.at(-1), ['http://h/app/t.js', 'controlled', 'http://h/app/sw.js']);
  assert.deepEqual(bus.thrown, []);
  // Where Shared Workers are not marked (Firefox), no channel opens.
  const before = bus.all.length;
  documentAt(initScript(S1, 'tell', 'm1', false), '/p', new Map(), 't0', { report: 'tell', told: [], globals: { ...workerGlobals().globals, ...swGlobals().globals, BroadcastChannel: bus.BroadcastChannel } });
  assert.equal(bus.all.length, before);
});

// Rejections no handler took while fn ran, and a few turns after.
const unhandled = async (fn) => {
  const got = [];
  const take = (e) => { got.push(e); };
  process.on('unhandledRejection', take);
  try { await fn(); for (let i = 0; i < 5; i++) await turn(); } finally { process.off('unhandledRejection', take); }
  return got;
};

test('each register holds keploy\'s Web Lock, shared, taken before the channel hears it and let go once the register settles, however it ends; a document asks for its registrations only after the browser said that no lock of that name is held or asked for: one that begins while another document\'s register is in flight never knows (its Shared Workers start as the app asked and are named), and neither does one whose lock read is refused or makes no sense, or one with no Web Locks; another lock changes nothing', async () => {
  const bus = channels();
  const m = lockManager();
  // The channel's messages, in order with the locks'.
  class BC extends bus.BroadcastChannel { postMessage(x) { m.log.push(['say', x.scope]); super.postMessage(x); } }
  const doc = (sw) => {
    const told = [];
    const w = workerGlobals();
    const d = documentAt(initScript(S1, 'tell', 'm1'), '/p', new Map(), 't0', { report: 'tell', told, globals: { ...w.globals, ...sw.globals, BroadcastChannel: BC } });
    return { d, told, made: () => w.made.map(([u]) => workerMark(u)) };
  };
  // a's register is in flight until release.
  let release = null;
  const a = doc(swGlobals({ locks: m, log: m.log, answer: (u) => new Promise((ok) => { release = () => ok({ active: { scriptURL: `http://h${u}` } }); }) }));
  await turn(); await turn();
  assert.deepEqual(m.log, [['query', 0], 'getRegistrations']);
  m.log.length = 0;
  a.d.run('navigator.serviceWorker.register("/app/sw.js");');
  assert.deepEqual(m.log, [['request', SW_LOCK, 'shared'], ['say', 'http://h/app/']]);
  // b begins meanwhile: it finds the lock held, never asks for its
  // registrations, and starts its Shared Workers as the app asked, even once
  // the register has settled.
  m.log.length = 0;
  const b = doc(swGlobals({ locks: m, log: m.log }));
  await turn(); await turn();
  assert.deepEqual(m.log, [['query', 1]]);
  b.d.run('new SharedWorker("/s.js");');
  release();
  await turn(); await turn();
  assert.deepEqual(m.held, []);
  b.d.run('new SharedWorker("/t.js");');
  assert.deepEqual([b.made(), b.told], [[null, null], [['http://h/s.js', 'early'], ['http://h/t.js', 'early']]]);
  // c begins after: no lock, so it asks, and finds the registration.
  m.log.length = 0;
  const c = doc(swGlobals({ locks: m, log: m.log, regs: [{ scope: 'http://h/app/', active: { scriptURL: 'http://h/app/sw.js' } }] }));
  await turn(); await turn();
  assert.deepEqual(m.log.slice(0, 2), [['query', 0], 'getRegistrations']);
  c.d.run('new SharedWorker("/s.js"); new SharedWorker("/app/s.js");');
  assert.deepEqual([c.made().map((x) => x && x.kind), c.told], [['s', null], [['http://h/app/s.js', 'controlled', 'http://h/app/sw.js']]]);
  // Two registers in flight at once both hold it.
  const two = lockManager();
  const t = doc(swGlobals({ locks: two, answer: () => new Promise(() => {}) }));
  t.d.run('navigator.serviceWorker.register("/x/sw.js"); navigator.serviceWorker.register("/y/sw.js");');
  await turn();
  assert.deepEqual(two.held, [{ name: SW_LOCK, mode: 'shared' }, { name: SW_LOCK, mode: 'shared' }]);
  // However the register ends, the lock goes: refused, thrown, Playwright's
  // block, no promise at all.
  for (const [how, answer, script] of [
    ['refused', () => Promise.reject(new TypeError('no')), 'navigator.serviceWorker.register("/sw.js").catch(() => {});'],
    ['thrown', () => { throw new TypeError('no'); }, 'try { navigator.serviceWorker.register("/sw.js"); } catch (e) {}'],
    ['blocked', async () => undefined, 'navigator.serviceWorker.register("/sw.js");'],
    ['no promise', () => 1, 'navigator.serviceWorker.register("/sw.js");'],
  ]) {
    const l = lockManager();
    const d = doc(swGlobals({ locks: l, answer }));
    d.d.run(script);
    await turn(); await turn();
    assert.deepEqual([l.asked.length, l.held], [1, []], how);
  }
  // A lock held or asked for, a lock read refused or one whose answer makes no
  // sense, or no Web Locks: never known. A lock of another name: known.
  const never = async (l) => {
    const d = doc(swGlobals({ locks: l }));
    await turn(); await turn();
    d.d.run('new SharedWorker("/s.js");');
    return [d.made(), d.told];
  };
  const pending = lockManager();
  pending.pending.push({ name: SW_LOCK, mode: 'shared' });
  const refused = lockManager();
  refused.locks.query = () => Promise.reject(new Error('SecurityError'));
  const odd = lockManager();
  odd.locks.query = () => Promise.resolve({});
  for (const [how, l] of [['pending', pending], ['refused', refused], ['odd', odd], ['none', null]]) {
    assert.deepEqual(await never(l), [[null], [['http://h/s.js', 'early']]], how);
  }
  const other = lockManager();
  other.held.push({ name: 'app-lock', mode: 'exclusive' });
  other.pending.push({ name: 'app-lock', mode: 'shared' });
  assert.deepEqual((await never(other))[1], []);
  // With no Web Locks, a register still answers as the browser's does, and a
  // context Playwright blocks still knows at once.
  const bare = doc(swGlobals({ locks: null }));
  assert.deepEqual(await bare.d.run('navigator.serviceWorker.register("/sw.js")'), { active: { scriptURL: 'http://h/sw.js' } });
  const blocked = swGlobals({ locks: null });
  blocked.globals.ServiceWorkerContainer.prototype.register = async () => { void 'Service Worker registration blocked by Playwright'; };
  const k = doc(blocked);
  k.d.run('new SharedWorker("/s.js");');
  assert.equal(k.made()[0].kind, 's');
  // A lock request or read the browser refuses says nothing to the app.
  assert.deepEqual(await unhandled(async () => {
    const r = lockManager();
    r.locks.request = () => Promise.reject(new Error('AbortError'));
    r.locks.query = () => Promise.reject(new Error('SecurityError'));
    doc(swGlobals({ locks: r })).d.run('navigator.serviceWorker.register("/sw.js");');
  }), []);
  assert.deepEqual(bus.thrown, []);
});

test('a worker\'s seeding draws the same numbers for a token and instance every run, others for another; its location shows no mark, its own query and fragment kept', () => {
  const t = 'cd'.repeat(16);
  const a = workerAt(markWorker('http://h/w.js', 'w', t), workerScript(t, 0, 'w')).draws();
  assert.deepEqual(workerAt('http://h/w.js', workerScript(t, 0, 'w')).draws(), a);
  assert.match(a.uuid, UUID_V4);
  assert.notDeepEqual(workerAt('http://h/w.js', workerScript(t, 1, 'w')).draws().random, a.random);
  assert.notDeepEqual(workerAt('http://h/w.js', workerScript('ef'.repeat(16), 0, 'w')).draws().random, a.random);
  assert.notDeepEqual(workerAt('http://h/w.js', '').draws().random, a.random);
  for (const [url, search] of [['http://h/w.js', ''], ['http://h/w.js?a=1', '?a=1'], ['http://h/w.js?', ''], ['http://h/w.js?a=1#f', '?a=1']]) {
    for (const kind of ['w', 'm']) {
      const w = workerAt(markWorker(url, kind, t), workerScript(t, 0, kind));
      assert.deepEqual([w.run('location.href'), w.run('location.search'), w.run('String(location)')], [url, search, url], `${kind} ${url}`);
    }
  }
  // Another worker's mark is not this one's: shown as it is.
  const other = markWorker('http://h/w.js', 'w', 'ef'.repeat(16));
  assert.equal(workerAt(other, workerScript(t, 0, 'w')).run('location.href'), other);
});

// A worker's seeding (token, instance n, kind; reach: whether the route
// reaches the scripts of the workers it starts) at /d/a.js?x=1, with a Worker
// that keeps what it is given (or W) and a fetch that keeps what it posts;
// code then runs in it.
const nestedAt = (token, n, kind, code, W, reach = true) => {
  const made = [];
  const posted = [];
  class Worker { constructor(url, opts) { made.push([String(url), opts === undefined ? undefined : JSON.parse(JSON.stringify(opts))]); } }
  const fetch = (u, o) => { posted.push([String(u), o === undefined ? undefined : JSON.parse(JSON.stringify(o))]); return Promise.resolve(); };
  const w = workerAt(markWorker('http://h/d/a.js?x=1', kind, token), workerScript(token, n, kind, reach), { URL, Worker: W ?? Worker, fetch, Request: class Request {} });
  return { made, posted, v: w.run(code) };
};

test('a Web Worker\'s seeding starts each Web Worker it starts at its script URL, resolved against the URL the app asked for, marked with a token of its own: the same each run, another for the next worker at that path, another path, token or instance; a module one is marked so; it keeps new, instanceof and its constructor; a Shared Worker\'s seeding leaves Worker as it is', () => {
  const t = 'cd'.repeat(16);
  const code = 'new Worker("b.js", { name: "b0" }); new Worker("b.js", null); new Worker("/e/m.js", { type: "module" }); new Worker("?q=1#f"); new Worker("#f"); new Worker("https://h/s.js"); 0';
  for (const kind of ['w', 'm']) {
    const a = nestedAt(t, 0, kind, code);
    const marks = a.made.map(([u]) => workerMark(u));
    assert.deepEqual(a.made.map(([, o], i) => [marks[i].kind, marks[i].url, o]), [['w', 'http://h/d/b.js', { name: 'b0' }], ['w', 'http://h/d/b.js', null],
      ['m', 'http://h/e/m.js', { type: 'module' }], ['w', 'http://h/d/a.js?q=1#f', undefined], ['w', 'http://h/d/a.js?x=1#f', undefined], ['w', 'https://h/s.js', undefined]], kind);
    for (const m of marks) assert.match(m.token, TOKEN);
    assert.equal(new Set(marks.map((m) => m.token)).size, 6);
    assert.deepEqual(nestedAt(t, 0, kind, code).made, a.made);
    assert.deepEqual(a.posted, []);
    for (const [tt, n] of [['ef'.repeat(16), 0], [t, 1]]) assert.notEqual(workerMark(nestedAt(tt, n, kind, code).made[0][0]).token, marks[0].token);
    assert.equal(nestedAt(t, 0, kind, 'const x = new Worker("b.js"); x instanceof Worker && Worker.prototype.constructor === Worker && Worker.name === "Worker" && Worker.length === 1').v, true);
    assert.throws(() => nestedAt(t, 0, kind, 'Worker("b.js")'), TypeError);
  }
  // Each worker counts its own: the same for the same worker.
  assert.equal(workerMark(nestedAt(t, 0, 'w', 'new Worker("b.js"); 0').made[0][0]).token, workerMark(nestedAt(t, 0, 'm', 'new Worker("b.js"); 0').made[0][0]).token);
  for (const kind of ['s', 'x']) assert.deepEqual(nestedAt(t, 0, kind, 'new Worker("b.js"); 0').made, [['b.js', undefined]], kind);
  // Where the route does not reach their scripts (Chromium, Firefox): each
  // starts as the app asked, and its address is posted, with why.
  const to = markWorker('http://h/d/a.js?x=1', 't', t);
  for (const kind of ['w', 'm']) {
    const a = nestedAt(t, 0, kind, 'new Worker("b.js", { name: "b0" }); new Worker("https://h/s.js?q=1"); new Worker("blob:http://h/0f"); 0', undefined, false);
    assert.deepEqual(a.made, [['b.js', { name: 'b0' }], ['https://h/s.js?q=1', undefined], ['blob:http://h/0f', undefined]], kind);
    assert.deepEqual(a.posted, [[to, { method: 'POST', body: '["nested","http://h/d/b.js"]' }], [to, { method: 'POST', body: '["nested","https://h/s.js"]' }],
      [to, { method: 'POST', body: '["worker","blob:"]' }]], kind);
  }
  assert.notEqual(workerScript(t, 0, 'w', true), workerScript(t, 0, 'w'));
});

test('a Web Worker\'s seeding starts a Web Worker keploy cannot mark as the app asked and posts its address to the worker\'s own URL marked t: a blob: or data: URL, or a marked URL the browser refuses; a URL the browser cannot read throws its own error and posts nothing', () => {
  const t = 'cd'.repeat(16);
  const to = markWorker('http://h/d/a.js?x=1', 't', t);
  const post = (at) => [to, { method: 'POST', body: JSON.stringify(['worker', at]) }];
  const a = nestedAt(t, 0, 'w', 'new Worker("blob:http://h/0f0e"); new Worker("data:text/javascript,1"); 0');
  assert.deepEqual([a.made.map(([u]) => u), a.posted], [['blob:http://h/0f0e', 'data:text/javascript,1'], [post('blob:'), post('data:')]]);
  const made = [];
  class Picky { constructor(url) { if (workerMark(String(url)) !== null) throw new TypeError('refused'); made.push(String(url)); } }
  assert.deepEqual(nestedAt(t, 0, 'm', 'new Worker("/e/b.js?q=1"); 0', Picky).posted, [post('http://h/e/b.js')]);
  assert.deepEqual(made, ['/e/b.js?q=1']);
  class Strict { constructor(url) { if (String(url) === 'http://[') throw new SyntaxError('the browser\'s own'); } }
  const posted = [];
  assert.throws(() => workerAt(markWorker('http://h/d/a.js', 'w', t), workerScript(t, 0, 'w'), { URL, Worker: Strict, fetch: (u) => { posted.push(u); return Promise.resolve(); }, Request: class Request {} })
    .run('new Worker("http://[")'), (e) => e.message === 'the browser\'s own');
  assert.deepEqual(posted, []);
});

test('a worker\'s seeding: an Error\'s or a DOMException\'s stack read through its prototype\'s getter (Firefox) leaves out each frame at a URL whose query has keploy\'s mark, any kind; its setter, flags and a value that is no string are kept; a stack that is no getter stays as it was', () => {
  const t = 'ab'.repeat(16);
  const href = markWorker('http://h/w.js', 'w', t);
  const kept = ['@http://h/w.js:1:2', `h@http://h/w.js?a__keploy_worker=w.${t}:7:8`, 'app@http://h/w.js:4:5', `k@http://h/w.js?__keploy_worker=w.${'ef'.repeat(16)}:2:2`];
  // The app's script runs at the worker's own marked URL (href): its frame
  // there is kept, with no mark; one at another worker's mark is not this one's.
  const frames = [kept[0], `VoidFunction*@${markWorker('http://h/w.js', 'q', t, 0)}:114:15`, `g@http://h/w.js?b=1&__keploy_worker=o.${t}:5:6`, `f@${markWorker('http://h/m.js', 'p', t, 0)}:3:4`, kept[1],
    `promise callback*@${markWorker('http://h/s.js?q=1', 's', 'ef'.repeat(16))}:9:1`, `app@${href}:4:5`, `${kept[3].replace('w.', 'm.')}`, ''];
  class DOMException {}
  const w = workerAt(href, '', { DOMException });
  w.run('for (const C of [Error, DOMException]) Object.defineProperty(C.prototype, \'stack\', { get() { return this.s; }, set(v) { this.set = v; }, enumerable: false, configurable: true });');
  w.run(workerScript(t, 0, 'w'));
  // V8 gives each error its own stack; an object made from the prototype
  // reads it through the prototype's getter, as Firefox's errors do.
  for (const C of ['Error', 'DOMException']) {
    assert.equal(w.run(`(() => { const e = Object.create(${C}.prototype); e.s = ${JSON.stringify(frames.join('\n'))}; return e.stack; })()`), [kept[0], kept[1], kept[2], ''].join('\n'), C);
    assert.equal(w.run(`(() => { const e = Object.create(${C}.prototype); e.stack = 'x'; return e.set; })()`), 'x', C);
    assert.equal(w.run(`(() => { const e = Object.create(${C}.prototype); e.s = 7; return e.stack; })()`), 7, C);
    const d = w.run(`Object.getOwnPropertyDescriptor(${C}.prototype, 'stack')`);
    assert.deepEqual([typeof d.get, typeof d.set, d.enumerable, d.configurable], ['function', 'function', false, true], C);
  }
  // A stack that is a value on the prototype, or none (V8, WebKit): as it was.
  const v = workerAt(href, '');
  v.run('Object.defineProperty(Error.prototype, \'stack\', { value: \'v\', writable: true, enumerable: false, configurable: true });');
  v.run(workerScript(t, 0, 'w'));
  assert.deepEqual(JSON.parse(v.run('JSON.stringify(Object.getOwnPropertyDescriptor(Error.prototype, \'stack\'))')), { value: 'v', writable: true, enumerable: false, configurable: true });
  assert.equal(workerAt(href, workerScript(t, 0, 'w')).run('Object.getOwnPropertyDescriptor(Error.prototype, \'stack\')'), undefined);
});

test('a worker\'s seeding: an error the browser\'s own call throws in a seeded getRandomValues or randomUUID, or in the location\'s href, search or toString, reaches the caller with each frame at a URL keploy marked (a query\'s mark or a data: module\'s parameter) left out of its own stack, through its setter or as its value, flags kept; a stack with no such frame, one that is no string, none of its own and a thrown value that is no object stay as they were; a page\'s errors go on as they are', () => {
  const t = 'cd'.repeat(16);
  const href = markWorker('http://h/w.js', 'w', t);
  const kept = ['TypeError: no', '    at f (http://h/w.js:1:2)', `    at g (http://h/w.js?a__keploy_worker=w.${t}:7:8)`, '    at app (http://h/w.js:8:9)', ''];
  const stack = [kept[0], `    at Crypto.getRandomValues (${markWorker('http://h/w.js', 'q', t, 0)}:30:5)`, kept[1], `    at x (data:text/javascript;__keploy_worker=x.${t};base64,QUJD:1:9)`,
    `    at y (${markWorker('http://h/m.js', 'p', t, 0)}:3:4)`, kept[2], `    at app (${href}:8:9)`, kept[4]].join('\n');
  // What the browser's own calls throw, in turn.
  const throws = [];
  const raise = () => { throw throws.shift(); };
  // A scope's own classes: its seeding wraps their prototypes' functions.
  const natives = () => {
    class Crypto { getRandomValues() { raise(); } randomUUID() { raise(); } }
    class WorkerLocation { get href() { return raise(); } get search() { return raise(); } toString() { return raise(); } }
    return { Crypto, crypto: new Crypto(), WorkerLocation, location: new WorkerLocation() };
  };
  const w = workerAt(href, workerScript(t, 0, 'w'), natives());
  const caught = (at, call) => [...at.run(`(() => { try { ${call}; } catch (e) { return [e]; } return []; })()`)];
  // An own stack read and written through a getter and a setter (V8's).
  const accessor = (s0) => {
    const e = new Error('no');
    let s = s0;
    const set = [];
    Object.defineProperty(e, 'stack', { get() { return s; }, set(v) { set.push(v); s = v; }, enumerable: false, configurable: true });
    return { e, set };
  };
  const calls = ['crypto.getRandomValues(new Uint8Array(1))', 'crypto.randomUUID()', 'location.href', 'location.search', 'String(location)'];
  for (const call of calls) {
    const a = accessor(stack);
    throws.push(a.e);
    assert.deepEqual(caught(w, call), [a.e], call);
    assert.deepEqual(a.set, [kept.join('\n')], call);
    const d = Object.getOwnPropertyDescriptor(a.e, 'stack');
    assert.deepEqual([typeof d.get, typeof d.set, d.enumerable], ['function', 'function', false], call);
    // A stack that is the error's own value (WebKit's).
    const v = new Error('no');
    Object.defineProperty(v, 'stack', { value: stack, writable: true, enumerable: false, configurable: true });
    throws.push(v);
    assert.deepEqual(caught(w, call), [v], call);
    assert.deepEqual(Object.getOwnPropertyDescriptor(v, 'stack'), { value: kept.join('\n'), writable: true, enumerable: false, configurable: true }, call);
  }
  // As they were: no frame keploy marked, a stack that is no string (never
  // read as one), an error with no stack of its own (Firefox's), a value
  // that is no object.
  const plain = accessor(kept.join('\n'));
  let read = 0;
  const odd = accessor({ toString() { read++; return stack; } });
  const none = Object.create(Error.prototype);
  for (const e of [plain.e, odd.e, none, 'thrown']) {
    throws.push(e);
    assert.deepEqual(caught(w, 'crypto.getRandomValues(new Uint8Array(1))'), [e]);
  }
  assert.deepEqual([plain.set, odd.set, read, Object.getOwnPropertyNames(none)], [[], [], 0, []]);
  // A page's seeded functions: what the browser throws goes on as it is.
  const { Crypto, crypto } = natives();
  const page = documentAt(initScript(S1), '/p', new Map(), 't0', { globals: { Crypto, crypto } });
  for (const call of calls.slice(0, 2)) {
    const a = accessor(stack);
    throws.push(a.e);
    assert.deepEqual(caught(page, call), [a.e], call);
    assert.deepEqual([a.set, a.e.stack], [[], stack], call);
  }
});

// A context whose route keeps its matcher and handler, and a route of it
// that records what the handler did. A request is a worker's script load as
// Chromium shows it (typed script, no sec-fetch-dest) unless as says.
// A fake browser context for workerRoutes, in Playwright's order: a page's
// routes before its context's, the last added first; a route that falls
// back hands the request on, at the URL its fallback gave, to the next
// route that matches it there, with the headers it gave. What answered it
// is what ask returns: the fetches (each one's URL, and the headers it sent
// when a route gave some) and the fulfill, continue or abort that ended it,
// or, when no route did, the fallback it went on to the server with.
function routed() {
  const r = {};
  const target = () => {
    const t = { routes: [] };
    t.route = async (match, handler) => { t.routes.unshift({ match, handler }); };
    t.unroute = async (match, handler) => { t.routes = t.routes.filter((x) => !(x.match === match && (handler === undefined || x.handler === handler))); };
    t.unrouteAll = async () => { t.routes = []; };
    return t;
  };
  const context = target();
  const pages = [];
  const listeners = [];
  context.pages = () => pages.slice();
  context.on = (event, f) => { if (event === 'page') listeners.push(f); };
  // list: the page shows its routes as Playwright's page does (_routes,
  // each with its handler), which keploy reads to know whether the test
  // has a route there.
  r.page = (list = false) => {
    const p = target();
    if (list) Object.defineProperty(p, '_routes', { get: () => p.routes });
    pages.push(p);
    for (const f of listeners) f(p);
    return p;
  };
  // keploy's first route's match.
  r.match = (u) => context.routes[0].match(u);
  r.ask = async (url, answer, as = { type: 'script', headers: {} }, page = null) => {
    const did = [];
    let at = url;
    let over;
    let ended = false;
    const request = { url: () => at, resourceType: () => as.type, headers: () => over?.headers ?? as.headers, method: () => as.method ?? 'GET', postData: () => as.body ?? null };
    const route = {
      request: () => request,
      fetch: async (o = {}) => {
        const h = o.headers ?? over?.headers;
        did.push(h === undefined ? ['fetch', o.url ?? at] : ['fetch', o.url ?? at, h]);
        if (answer instanceof Error) throw answer;
        if (answer.followed !== undefined && o.maxRedirects !== 0) return answer.followed;
        return answer;
      },
      fulfill: async (o) => { ended = true; r.raw = o.body; did.push(['fulfill', { ...o, body: String(o.body) }]); },
      continue: async (o) => {
        if (as.dropped) throw new Error('Target closed');
        ended = true;
        did.push(o?.headers === undefined ? ['continue', o?.url ?? at] : ['continue', o?.url ?? at, o.headers]);
      },
      abort: async (e) => {
        if (as.dropped) throw new Error('Target closed');
        ended = true;
        did.push(e === undefined ? ['abort'] : ['abort', e]);
      },
      fallback: async (o) => {
        if (o === undefined || Object.keys(o).length === 0) return;
        over = { ...over, ...o };
        if (o.url !== undefined) at = o.url;
      },
    };
    for (const t of page === null ? [context] : [page, context]) {
      for (const x of t.routes.slice()) {
        if (ended) break;
        if (!t.routes.includes(x) || !x.match(new URL(at))) continue;
        await x.handler(route, request);
      }
    }
    if (!ended) did.push(over === undefined ? ['fallback'] : ['fallback', over]);
    return did;
  };
  return { r, context };
}
const answerOf = (status, body, headers = { 'content-type': 'text/javascript', 'content-encoding': 'gzip', 'content-length': '3', 'x-a': '1' }) =>
  ({ ok: () => status >= 200 && status < 300, status: () => status, headers: () => headers, body: async () => Buffer.from(body) });

test('workerRoutes answers a marked classic worker script with its seeding then, in a microtask, importScripts of the app\'s own at its URL with no mark, under the status and headers the app\'s server gave it; each start of a token is the next instance', async () => {
  const { r, context } = routed();
  await workerRoutes(context);
  const t = '01'.repeat(16);
  assert.equal(r.match(new URL(markWorker('http://h/w.js', 'w', t))), true);
  assert.equal(r.match(new URL('http://h/w.js?a=1')), false);
  const headers = { 'content-type': 'text/javascript', 'x-a': '1' };
  assert.deepEqual(await r.ask(markWorker('http://h/w.js?a=1#f', 'w', t), answerOf(201, 'app()')), [['fetch', 'http://h/w.js?a=1#f'],
    ['fulfill', { status: 201, headers, body: `importScripts(${JSON.stringify(markWorker('http://h/w.js?a=1#f', 'q', t, 0))});app()\n//# sourceURL=http://h/w.js?a=1\n` }]]);
  const second = await r.ask(markWorker('http://h/w.js?a=1', 'w', t), answerOf(200, 'app()'));
  assert.equal(second[1][1].body, workerAnswer(t, 1, 'w', 'http://h/w.js?a=1', true, 'app()'));
  // The app's bytes as the server sent them: a byte order mark stays first, and a Latin-1 byte stays that byte.
  await r.ask(markWorker('http://h/w.js', 'w', t), { ...answerOf(200, ''), body: async () => Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xc3, 0xa9]) });
  const q2 = `importScripts(${JSON.stringify(markWorker('http://h/w.js', 'q', t, 2))});`;
  assert.deepEqual(r.raw, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(q2), Buffer.from([0x61, 0xc3, 0xa9]), Buffer.from('\n//# sourceURL=http://h/w.js\n')]));
  await r.ask(markWorker('http://h/w.js', 'w', t), { ...answerOf(200, '', { 'content-type': 'text/javascript; charset=iso-8859-1' }), body: async () => Buffer.from([0x68, 0xe9]) });
  const q3 = `importScripts(${JSON.stringify(markWorker('http://h/w.js', 'q', t, 3))});`;
  assert.deepEqual(r.raw, Buffer.concat([Buffer.from(q3), Buffer.from([0x68, 0xe9]), Buffer.from('\n//# sourceURL=http://h/w.js\n')]));
  // With no source (keploy could not fetch it), its seeding, then the app's script loaded in a microtask.
  assert.equal(workerAnswer(t, 1, 'w', 'http://h/w.js?a=1'), `importScripts(${JSON.stringify(markWorker('http://h/w.js?a=1', 'q', t, 1))});queueMicrotask(importScripts.bind(globalThis, "http://h/w.js?a=1"));\n`);
});

test('workerRoutes answers a module worker script with an import of its seeding then one of the app\'s own; its seeding is workerScript; an answer not ok goes as given; one it cannot fetch gets its seeding with no header of the app\'s; a malformed mark falls back', async () => {
  const { r, context } = routed();
  const answered = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()) });
  const t = '23'.repeat(16);
  const did = await r.ask(markWorker('http://h/m.js', 'm', t), answerOf(200, 'export {}'));
  assert.equal(did[1][1].body, `import ${JSON.stringify(markWorker('http://h/m.js', 'p', t, 0))};export {}\n//# sourceURL=http://h/m.js\n`);
  assert.equal(workerAnswer(t, 0, 'm', 'http://h/m.js'), `import ${JSON.stringify(markWorker('http://h/m.js', 'p', t, 0))};\nimport "http://h/m.js";\n`);
  assert.deepEqual(await r.ask(markWorker('http://h/m.js', 'p', t, 0)), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(t, 0, 'm') }]]);
  assert.deepEqual(await r.ask(markWorker('http://h/m.js', 'w', t), answerOf(404, 'no')), [['fetch', 'http://h/m.js'],
    ['fulfill', { status: 404, headers: { 'content-type': 'text/javascript', 'x-a': '1' }, body: 'no' }]]);
  assert.deepEqual(await r.ask(markWorker('http://h/m.js', 'w', t), new Error('net')), [['fetch', 'http://h/m.js'],
    ['fulfill', { status: 200, headers: { 'content-type': 'text/javascript' }, body: workerAnswer(t, 2, 'w', 'http://h/m.js') }]]);
  const x = markWorker('http://h/x.js', 'x', t);
  assert.equal((await r.ask(x, new Error('net')))[1][1].body, workerAnswer(t, 3, 'x', 'http://h/x.js', true));
  assert.equal(answered.length, 5);
  assert.deepEqual(await r.ask(`http://h/m.js?__keploy_worker=w.${t}.3`), [['fallback']]);
  assert.deepEqual(await r.ask(`http://h/m.js?__keploy_worker=o.${t}.3`), [['fallback']]);
  assert.equal(answered.length, 5);
});

test('workerRoutes answers a marked URL as a worker\'s script only when the browser loads it as one (sec-fetch-dest worker or sharedworker where the route sees it, else typed script): what the worker\'s own code asks for there (fetch(\'\'), XMLHttpRequest, importScripts) goes on with no mark and starts no instance of its token', async () => {
  const { r, context } = routed();
  const answered = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()) });
  const t = '67'.repeat(16);
  const w = markWorker('http://h/w.js?a=1', 'w', t);
  const as = (type, dest) => ({ type, headers: dest === undefined ? {} : { 'sec-fetch-dest': dest } });
  const own = [
    as('fetch'), as('xhr'), as('other'), // Chromium: fetch, XMLHttpRequest, importScripts
    as('fetch', 'empty'), as('script', 'script'), // Firefox: fetch, importScripts
    as('xhr', 'empty'), as('xhr', 'script'), // WebKit: XMLHttpRequest, importScripts
  ];
  for (const a of own) assert.deepEqual(await r.ask(w, answerOf(200, 'app()'), a), [['fallback', { url: 'http://h/w.js?a=1' }]], JSON.stringify(a));
  assert.deepEqual(await r.ask(markWorker('http://h/m.js', 'p', t, 0), undefined, as('fetch', 'empty')), [['fallback', { url: 'http://h/m.js' }]]);
  assert.deepEqual(answered, []);
  // The worker's script, as each engine loads it: its first start is n 0.
  const headers = { 'content-type': 'text/javascript', 'x-a': '1' };
  assert.deepEqual(await r.ask(w, answerOf(200, 'app()'), as('xhr', 'worker')), [['fetch', 'http://h/w.js?a=1'],
    ['fulfill', { status: 200, headers, body: workerAnswer(t, 0, 'w', 'http://h/w.js?a=1', true, 'app()') }]]);
  assert.equal((await r.ask(w, answerOf(200, 'app()'), as('script', 'worker')))[1][1].body, workerAnswer(t, 1, 'w', 'http://h/w.js?a=1', true, 'app()'));
  assert.equal((await r.ask(w, answerOf(200, 'app()'), as('script')))[1][1].body, workerAnswer(t, 2, 'w', 'http://h/w.js?a=1', true, 'app()'));
  // A classic worker's seeding, at its q mark, as each engine loads it by
  // importScripts (Chromium: other; Firefox: script; WebKit: xhr, dest
  // script); what its code asks for there goes on with no mark.
  const q = markWorker('http://h/w.js?a=1', 'q', t, 2);
  for (const a of [as('other'), as('script', 'script'), as('xhr', 'script')]) {
    assert.deepEqual(await r.ask(q, undefined, a), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(t, 2, 'w') }]], JSON.stringify(a));
  }
  for (const a of [as('fetch'), as('xhr'), as('script'), as('fetch', 'empty'), as('script', 'worker')]) {
    assert.deepEqual(await r.ask(q, undefined, a), [['fallback', { url: 'http://h/w.js?a=1' }]], JSON.stringify(a));
  }
  const s = '89'.repeat(16);
  assert.equal((await r.ask(markWorker('http://h/s.js', 's', s), answerOf(200, 'app()'), as('xhr', 'sharedworker')))[1][1].body, workerAnswer(s, 0, 's', 'http://h/s.js'));
  assert.deepEqual(await r.ask(markWorker('http://h/m.js', 'p', t, 0), undefined, as('script', 'worker')), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(t, 0, 'm') }]]);
  assert.equal(answered.length, 8);
});

test('workerRoutes answers a seeded Web Worker\'s word of a worker keploy cannot mark (marked t) itself, with no body, and hears its address; one with no address is answered and names none; neither reaches a route of the test\'s', async () => {
  const { r, context } = routed();
  const answered = [];
  const unmarked = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()), unmarked: (at, why) => unmarked.push([why, at]) });
  let theirs = 0;
  await context.route('**/*', async (route) => { theirs++; await route.continue(); });
  const t = 'ab'.repeat(16);
  const to = markWorker('http://h/d/a.js?x=1', 't', t);
  const one = [['worker', 'blob:']];
  const two = [...one, ['nested', 'http://h/e/b.js']];
  const words = [['["worker","blob:"]', one], ['["nested","http://h/e/b.js"]', two], [undefined, two], ['blob:', two], ['["routed","http://h/x.js"]', two],
    ['["worker",""]', two], ['["worker",7]', two], ['{"0":"worker","1":"blob:"}', two]];
  for (const [body, said] of words) {
    assert.deepEqual(await r.ask(to, undefined, { type: 'fetch', headers: { 'sec-fetch-dest': 'empty' }, body }), [['fulfill', { status: 204, body: 'undefined' }]]);
    assert.deepEqual(unmarked, said);
  }
  assert.deepEqual([answered.length, new Set(answered).size, theirs], [words.length, 1, 0]);
});

test('cspAllowsData: no policy, or each policy whose script or worker source list is named lists data:; a policy that names one without it refuses', () => {
  const csp = (v) => ({ 'content-security-policy': v });
  assert.equal(cspAllowsData({}), true);
  for (const v of ["img-src 'self'", "script-src 'self' data:", "default-src 'self' DATA:", "script-src data:; worker-src data:", "script-src-elem data:; worker-src 'self' data:"]) assert.equal(cspAllowsData(csp(v)), true, v);
  for (const v of ["script-src 'self'", "default-src 'self'", "script-src data:; worker-src 'self'", "script-src-elem 'self'; script-src data:", "child-src 'self'; script-src data:",
    "script-src data:, default-src 'self'", "script-src data:\nscript-src 'none'", "script-src 'none'; script-src data:", "SCRIPT-SRC 'self'",
    "script-src data:; Worker-Src 'self'"]) assert.equal(cspAllowsData(csp(v)), false, v);
});

test('workerAnswer: a classic Web or Shared Worker runs its seeding, then imports the app\'s script at its URL in a microtask it queues, with none of its own code on the stack; its location shows no mark; a module one imports its seeding as a data: module, then the app\'s script', () => {
  const t = '45'.repeat(16);
  // A classic Web Worker whose script keploy could not fetch loads its
  // seeding at its q mark first, then the app's script, in a microtask.
  const wh = markWorker('http://h/w.js?q=1', 'w', t);
  const wq = markWorker('http://h/w.js?q=1', 'q', t, 2);
  const imp = [];
  const later = [];
  const ww = workerAt(wh, '', { importScripts: function (...u) { imp.push(u); if (u[0] === wq) ww.run(workerScript(t, 2, 'w')); }, queueMicrotask: (f) => { later.push(f); } });
  ww.run(workerAnswer(t, 2, 'w', 'http://h/w.js?q=1'));
  assert.deepEqual([imp, later.length], [[[wq]], 1]);
  later[0]();
  assert.deepEqual(imp, [[wq], ['http://h/w.js?q=1']]);
  assert.deepEqual(ww.draws(), workerAt(wh, workerScript(t, 2, 'w')).draws());
  assert.equal(ww.run('location.href'), 'http://h/w.js?q=1');
  for (const kind of ['s']) {
    const href = markWorker('http://h/s.js?q=1', kind, t);
    const imported = [];
    const queued = [];
    const w = workerAt(href, workerAnswer(t, 2, kind, 'http://h/s.js?q=1'), {
      importScripts: function (...u) { imported.push([this, ...u]); },
      queueMicrotask: (f) => { queued.push(f); },
    });
    // Nothing of the app's runs while the answer's code is on the stack.
    assert.deepEqual(imported, [], kind);
    assert.equal(queued.length, 1, kind);
    queued[0]();
    assert.deepEqual(imported, [[w.run('globalThis'), 'http://h/s.js?q=1']], kind);
    assert.deepEqual(w.draws(), workerAt(href, workerScript(t, 2, kind)).draws(), kind);
    assert.equal(w.run('location.href'), 'http://h/s.js?q=1', kind);
  }
  const m = workerAnswer(t, 2, 'x', 'http://h/m.js?q=1');
  // Its media type carries the mark, so a stack can leave its frames out.
  const data = new RegExp(`^import "data:text/javascript;__keploy_worker=x\\.${t};base64,([A-Za-z0-9+/=]+)";\\nimport "http://h/m\\.js\\?q=1";\\n$`).exec(m);
  assert.ok(data, m.slice(0, 120));
  assert.equal(Buffer.from(data[1], 'base64').toString(), workerScript(t, 2, 'x'));
});

// A module Shared Worker's answer where data: is refused, run as a script:
// its import() is load, and its global holds an EventTarget's listeners.
function heldWorker(t, load) {
  const body = workerAnswer(t, 0, 'x', 'http://h/c.js', false);
  assert.equal(body.split('await import("http://h/c.js")').length, 2, body.slice(-400));
  const events = new EventTarget();
  const href = markWorker('http://h/c.js', 'x', t);
  const listeners = { added: [], removed: [] };
  const queued = [];
  const w = workerAt(href, '', {
    addEventListener: (type, f) => { listeners.added.push([type, f]); events.addEventListener(type, f); },
    removeEventListener: (type, f) => { listeners.removed.push([type, f]); events.removeEventListener(type, f); },
    dispatchEvent: events.dispatchEvent.bind(events),
    MessageEvent, load,
    queueMicrotask: (f) => { queued.push(f); queueMicrotask(f); },
  });
  const done = w.run(`(async () => { ${body.replace('await import(', 'await load(')} })()`);
  return { w, events, done, listeners, queued };
}

test('workerAnswer: a module Shared Worker whose policy refuses data: runs its seeding in its answer, then imports the app\'s script; each connect event before that script has run is held and given after, in order, with its ports; then it holds none, and one after goes to the app\'s handler as it comes', async () => {
  const t = '89'.repeat(16);
  let loaded;
  const got = [];
  const { w, events, done, listeners, queued } = heldWorker(t, () => new Promise((resolve) => { loaded = resolve; }));
  assert.deepEqual(w.draws(), workerAt(markWorker('http://h/c.js', 'x', t), workerScript(t, 0, 'x')).draws());
  assert.equal(w.run('location.href'), 'http://h/c.js');
  const a = new MessageChannel();
  const b = new MessageChannel();
  events.dispatchEvent(new MessageEvent('connect', { data: '', ports: [a.port1] }));
  events.dispatchEvent(new MessageEvent('connect', { data: '', ports: [b.port1] }));
  // The app's script sets its handler as it runs.
  events.addEventListener('connect', (e) => got.push(e.ports[0]));
  assert.deepEqual(got, []);
  loaded();
  await done;
  // It holds no more once the app's script has run.
  assert.equal(listeners.added.length, 1);
  assert.deepEqual(listeners.removed, listeners.added);
  assert.equal(got.length, 2);
  assert.ok(got[0] === a.port1 && got[1] === b.port1);
  // Each in a microtask of its own: none of the answer's code is on the
  // stack of the app's handler.
  assert.equal(queued.length, 2);
  const c = new MessageChannel();
  events.dispatchEvent(new MessageEvent('connect', { data: '', ports: [c.port1] }));
  assert.equal(got.length, 3);
  assert.ok(got[2] === c.port1);
  for (const ch of [a, b, c]) { ch.port1.close(); ch.port2.close(); }
});

test('workerAnswer: a module Shared Worker whose app script fails to load fails as it would, and the connect events it held are still given', async () => {
  const t = '8a'.repeat(16);
  const { events, done } = heldWorker(t, () => Promise.reject(new TypeError('no module')));
  const got = [];
  events.addEventListener('connect', (e) => got.push(e));
  const ch = new MessageChannel();
  events.dispatchEvent(new MessageEvent('connect', { data: '', ports: [ch.port1] }));
  await assert.rejects(done, /no module/);
  assert.equal(got.length, 2);
  ch.port1.close(); ch.port2.close();
});

test('workerRoutes keeps keploy\'s route ahead of every route the test adds to its context or its pages, after unrouteAll too: the test\'s route sees a worker\'s script load at the URL the app asked for; continuing it has keploy answer it with its seeding, answering it itself answers it unseeded and is heard, aborting it aborts it, falling back leaves it to keploy; what the worker\'s own code asks for at its marked URL reaches it with no mark; a module worker\'s seeding never reaches it', async () => {
  const { r, context } = routed();
  const before = r.page();
  const heard = [];
  const answered = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()), routed: (at) => heard.push(at) });
  const page = r.page();
  const t = 'ab'.repeat(16);
  const w = markWorker('http://h/w.js?a=1', 'w', t);
  const seen = [];
  const pass = async (route, q) => { seen.push(q.url()); await route.continue(); };
  await page.route(() => true, pass);
  const headers = { 'content-type': 'text/javascript', 'x-a': '1' };
  const seeded = (n) => [['fetch', 'http://h/w.js?a=1'], ['fulfill', { status: 200, headers, body: workerAnswer(t, n, 'w', 'http://h/w.js?a=1', true, 'app()') }]];
  assert.deepEqual(await r.ask(w, answerOf(200, 'app()'), undefined, page), seeded(0));
  assert.deepEqual(seen, ['http://h/w.js?a=1']);
  assert.deepEqual(answered, ['http://h/w.js?a=1']);
  // The worker's own XMLHttpRequest at its marked URL, and a module
  // worker's seeding, which keploy answers before any route of the test's.
  assert.deepEqual(await r.ask(w, undefined, { type: 'xhr', headers: { 'sec-fetch-dest': 'empty' } }, page), [['continue', 'http://h/w.js?a=1']]);
  assert.deepEqual(await r.ask(markWorker('http://h/m.js', 'p', t, 0), undefined, undefined, page), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(t, 0, 'm') }]]);
  assert.deepEqual(seen, ['http://h/w.js?a=1', 'http://h/w.js?a=1']);
  // A page that was open before: the test's route answers the script itself.
  await before.route(() => true, (route) => route.fulfill({ status: 200, body: 'mine()' }));
  assert.deepEqual(await r.ask(w, answerOf(200, 'app()'), undefined, before), [['fulfill', { status: 200, body: 'mine()' }]]);
  assert.deepEqual(heard, ['http://h/w.js']);
  // The context, for a request of no page: aborted, then left to keploy.
  await context.route(() => true, (route) => route.abort());
  assert.deepEqual(await r.ask(w, answerOf(200, 'app()')), [['abort']]);
  // After the context's unrouteAll, with no route added after it, keploy's
  // routes are back: its first answers a request of no page.
  await context.unrouteAll();
  assert.deepEqual(await r.ask(w, answerOf(200, 'app()')), seeded(1));
  await context.route(() => true, (route) => route.fallback());
  assert.deepEqual(await r.ask(w, answerOf(200, 'app()')), seeded(2));
  // After the page's unrouteAll, keploy's route is ahead of the next again.
  await page.unrouteAll();
  await page.route(() => true, pass);
  assert.deepEqual(await r.ask(w, answerOf(200, 'app()'), undefined, page), seeded(3));
  assert.deepEqual(heard, ['http://h/w.js']);
  // One route of keploy's ahead on each, the one it replaced taken off;
  // the context's last route stays last.
  for (const x of [context, page, before]) assert.equal(x.routes.filter((y) => y.match === x.routes[0].match).length, 1);
  assert.equal(context.routes.length, 3);
  assert.equal(context.routes[2].match(new URL('http://h/w.js?a=1')), true);
  assert.equal(context.routes[2].match(new URL('http://h/v.js')), false);
});

// x, or 'still waiting' if it has not settled within a bounded number of
// turns: a fake route answers at once, so an answer that never ends the load
// it began fails a row instead of hanging it.
const ends = async (x) => Promise.race([x, (async () => { for (let i = 0; i < 200; i++) await turn(); return 'still waiting'; })()]);

// A redirect answer: status with its Location at, at URL u, and what
// a fetch that follows it gets (followed).
const movedOf = (status, at, u, followed = answerOf(200, 'app()')) => ({ ...answerOf(status, '', { location: at, 'content-length': '0', 'x-r': '1' }), url: () => u, followed });

test('workerRoutes follows no redirect of a worker\'s script: Firefox gets the server\'s redirect, its Location whole at the URL keploy asked for; WebKit sends the request on as the test\'s routes asked; Chromium stops it (blocked by client), as one sent on would loop; the test hears of each load, with how; a 3xx that is no redirect, or one with no Location, goes to the worker as the server gave it', async () => {
  const t = 'ab'.repeat(16);
  assert.equal(STOPPED, 'blockedbyclient');
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const { r, context } = routed();
    const heard = [];
    const answered = [];
    await workerRoutes(context, { redirected: (at, how) => heard.push([at, how]), answered: (q) => answered.push(q.url()) }, engine);
    for (const [kind, status] of [['w', 301], ['m', 302], ['s', 303], ['x', 307], ['w', 308]]) {
      const before = answered.length;
      const got = await r.ask(markWorker('http://h/rd/w.js?a=1', kind, t), movedOf(status, 'v2/w.js', 'http://h/rd/w.js?a=1'));
      const then = {
        firefox: ['fulfill', { status, headers: { location: 'http://h/rd/v2/w.js', 'x-r': '1' }, body: '' }],
        webkit: ['continue', 'http://h/rd/w.js?a=1'],
        chromium: ['abort', 'blockedbyclient'],
      }[engine];
      assert.deepEqual(got, [['fetch', 'http://h/rd/w.js?a=1'], then], `${kind} ${status} ${engine}`);
      // Answered: each one keploy fulfilled or stopped; of those sent on, a Shared Worker's (s, x) only.
      assert.equal(answered.length - before, engine !== 'webkit' || kind === 's' || kind === 'x' ? 1 : 0, `${kind} ${status} ${engine}`);
    }
    const how = { firefox: 'followed', webkit: 'twice', chromium: 'stopped' }[engine];
    assert.deepEqual(heard, Array(5).fill(['http://h/rd/w.js', how]));
    // A Location that keeps only the fragment: whole, at the URL keploy asked for, never the marked one.
    const frag = await r.ask(markWorker('http://h/rd/w.js', 'w', t), movedOf(302, '#x', 'http://h/rd/w.js'));
    if (engine === 'firefox') assert.equal(frag[1][1].headers.location, 'http://h/rd/w.js#x');
    // Not redirects: a 300 with a Location, and a 302 with none, go to the worker as the server gave them.
    for (const [status, headers] of [[300, { location: 'v2/w.js' }], [302, {}]]) {
      const got = await r.ask(markWorker('http://h/rd/w.js', 'w', t), { ...answerOf(status, 'x', headers), url: () => 'http://h/rd/w.js', followed: answerOf(200, 'app()') });
      assert.deepEqual(got, [['fetch', 'http://h/rd/w.js'], ['fulfill', { status, headers, body: 'x' }]], `${status}`);
    }
    assert.equal(heard.length, 6);
  }
  // A route of the test's that continues it with headers of its own: keploy's fetch carries them, and in WebKit the request sent on too;
  // in Chromium keploy stops it through that route.
  for (const engine of ['webkit', 'chromium']) {
    const { r, context } = routed();
    await workerRoutes(context, {}, engine);
    const page = r.page();
    await page.route(() => true, (route) => route.continue({ headers: { 'x-auth': 'k' } }));
    assert.deepEqual(await r.ask(markWorker('http://h/rd/w.js', 'm', t), movedOf(302, '/v2/w.js', 'http://h/rd/w.js'), { type: 'script', headers: {} }, page),
      [['fetch', 'http://h/rd/w.js', { 'x-auth': 'k' }], engine === 'webkit' ? ['continue', 'http://h/rd/w.js', { 'x-auth': 'k' }] : ['abort', 'blockedbyclient']], engine);
    // A route of the test's that falls back: keploy's last route sends it on (WebKit) or stops it (Chromium).
    const { r: rf, context: cf } = routed();
    await workerRoutes(cf, {}, engine);
    const pf = rf.page();
    await pf.route(() => true, (route) => route.fallback());
    assert.deepEqual(await rf.ask(markWorker('http://h/rd/w.js', 'w', t), movedOf(302, 'v2/w.js', 'http://h/rd/w.js'), { type: 'script', headers: {} }, pf),
      [['fetch', 'http://h/rd/w.js'], engine === 'webkit' ? ['continue', 'http://h/rd/w.js'] : ['abort', 'blockedbyclient']], `${engine} fallback`);
    // A load that sending on or stopping fails for (the browser dropped it) ends: answered, and the error goes to the test's continue.
    const ended = [];
    const { r: r2, context: c2 } = routed();
    await workerRoutes(c2, { answered: () => ended.push('answered') }, engine);
    const p2 = r2.page();
    await p2.route(() => true, (route) => route.continue({ headers: { 'x-b': '1' } }).catch((e) => { ended.push(e.message); }));
    const asked = await ends(r2.ask(markWorker('http://h/rd/w.js', 'w', t), movedOf(302, 'v2/w.js', 'http://h/rd/w.js'), { type: 'script', headers: {}, dropped: true }, p2));
    assert.notEqual(asked, 'still waiting', engine);
    assert.deepEqual(ended, ['answered', 'Target closed'], engine);
  }
  assert.equal(redirectLine('t', 'http://h/rd/w.js', 'twice'), 'keploy: in t, the worker at http://h/rd/w.js draws the browser\'s own random numbers, and so does each worker it starts, so their draws may differ at replay: ' +
    'the server redirects its script, and no route reaches the URL a redirect gives (Playwright routes only its first request), so keploy cannot put its seeding ahead of the script; ' +
    'the worker runs at the URL the redirect gives, as with seeding off, and the server was asked for the script\'s first URL once more than with seeding off (keploy asked it, to see the redirect); ' +
    'serve the worker\'s script where the tests run at the URL the app starts the worker at, with no redirect, to seed it.');
  assert.equal(redirectLine('t', 'a', 'followed'), redirectLine('t', 'a', 'twice').replace(', and the server was asked for the script\'s first URL once more than with seeding off (keploy asked it, to see the redirect)', ''));
  assert.notEqual(redirectLine('t', 'a', 'followed'), redirectLine('t', 'a', 'twice'));
  assert.equal(redirectLine('t', 'http://h/rd/w.js', 'stopped'), 'keploy: in t, the worker at http://h/rd/w.js does not start: the server redirects its script, and in Chromium Playwright follows no redirect ' +
    'of a request whose URL a route changed (it asks for the first URL again until the browser gives up, as for a test\'s own route.continue({ url })), ' +
    'while keploy changes the URL of a seeded worker\'s script load to take its mark off before the request leaves the browser; ' +
    'so keploy stopped the load after asking the server for the script once, to see the redirect, and the worker fails to load (its error event), ' +
    'where with seeding off it runs at the URL the redirect gives; to run it, serve the worker\'s script where the tests run at the URL the app starts ' +
    'the worker at, with no redirect (keploy then seeds it), turn seeding off for this test (test.use({ keploySeedRandom: false })), or run it in Firefox or WebKit.');
});

test('workerRoutes sends a worker\'s script on with what the test\'s continue and fallbacks asked (a URL or headers of their own), at a URL a fallback gave too; a Shared Worker\'s, classic or module, that they asked for otherwise than the browser sent it gets the answer to what they asked, whole, unseeded, and is heard; the browser\'s own headers in another case or with one given as undefined, an option left undefined, or none, seed it', async () => {
  const { r, context } = routed();
  const heard = [];
  await workerRoutes(context, { routed: (at, why) => heard.push([at, why]) });
  const page = r.page();
  let mine = (route) => route.continue();
  await page.route(() => true, (route) => mine(route));
  const t = 'cd'.repeat(16);
  const headers = { 'content-type': 'text/javascript', 'x-a': '1' };
  const ask = (m, body, dest) => r.ask(m, answerOf(200, body), { type: 'script', headers: { 'sec-fetch-dest': dest, accept: '*/*' } }, page);
  const sent = (dest) => ({ 'sec-fetch-dest': dest, accept: '*/*' });
  const auth = (dest) => ({ ...sent(dest), 'x-auth': 'k' });
  const seeded = (url, h, n, kind, own, tok = t, src = undefined) => [h === undefined ? ['fetch', url] : ['fetch', url, h], ['fulfill', { status: 200, headers, body: workerAnswer(tok, n, kind, own, true, src) }]];
  const whole = (url, h, body) => [h === undefined ? ['fetch', url] : ['fetch', url, h], ['fulfill', { status: 200, headers, body }]];
  // A Web Worker's: keploy's fetch sends what the test's route asked (its
  // seeding's load of the app's script gets what that fetch got: a row below).
  const w = markWorker('http://h/w.js', 'w', t);
  mine = (route) => route.continue({ headers: auth('worker') });
  assert.deepEqual(await ask(w, 'app()', 'worker'), seeded('http://h/w.js', auth('worker'), 0, 'w', 'http://h/w.js', t, 'app()'));
  mine = (route) => route.continue({ url: 'http://h/stand.js' });
  assert.deepEqual(await ask(w, 'stand()', 'worker'), seeded('http://h/stand.js', undefined, 1, 'w', 'http://h/w.js', t, 'stand()'));
  // Fallbacks: keploy's last route answers it with what they gave, at the
  // URL one gave too.
  mine = (route) => route.fallback({ headers: auth('worker') });
  assert.deepEqual(await ask(w, 'app()', 'worker'), seeded('http://h/w.js', auth('worker'), 2, 'w', 'http://h/w.js', t, 'app()'));
  mine = (route) => route.fallback({ url: 'http://h/stand.js' });
  assert.deepEqual(await ask(w, 'stand()', 'worker'), seeded('http://h/stand.js', undefined, 3, 'w', 'http://h/w.js', t, 'stand()'));
  assert.deepEqual(heard, []);
  // A Shared Worker's: the browser's own headers (in another case), an
  // option left undefined, or none, seed it.
  const ts = 'ce'.repeat(16);
  const s = markWorker('http://h/s.js', 's', ts);
  const other = { 'Sec-Fetch-Dest': 'sharedworker', ACCEPT: '*/*' };
  mine = (route) => route.continue({ headers: other, url: undefined });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), seeded('http://h/s.js', other, 0, 's', 'http://h/s.js', ts));
  mine = (route) => route.continue();
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), seeded('http://h/s.js', undefined, 1, 's', 'http://h/s.js', ts));
  // A header given as undefined, which Playwright does not send.
  const none = { ...sent('sharedworker'), 'x-none': undefined };
  mine = (route) => route.continue({ headers: none });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), seeded('http://h/s.js', none, 2, 's', 'http://h/s.js', ts));
  assert.deepEqual(heard, []);
  // Another header, one taken off, one the browser sent with another value,
  // another URL, or a fallback's header: the answer to what they asked,
  // whole, and heard.
  mine = (route) => route.continue({ headers: auth('sharedworker') });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('http://h/s.js', auth('sharedworker'), 'app()'));
  const fewer = { ...sent('sharedworker'), accept: undefined };
  mine = (route) => route.continue({ headers: fewer });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('http://h/s.js', fewer, 'app()'));
  const changed = { ...sent('sharedworker'), accept: 'text/javascript' };
  mine = (route) => route.continue({ headers: changed });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('http://h/s.js', changed, 'app()'));
  mine = (route) => route.continue({ url: 'http://h/stand.js' });
  assert.deepEqual(await ask(s, 'stand()', 'sharedworker'), whole('http://h/stand.js', undefined, 'stand()'));
  mine = (route) => route.fallback({ headers: auth('sharedworker') });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('http://h/s.js', auth('sharedworker'), 'app()'));
  // A module Shared Worker's too.
  const tx = 'cf'.repeat(16);
  const x = markWorker('http://h/x.js', 'x', tx);
  mine = (route) => route.continue({ headers: auth('sharedworker') });
  assert.deepEqual(await ask(x, 'app()', 'sharedworker'), whole('http://h/x.js', auth('sharedworker'), 'app()'));
  mine = (route) => route.continue();
  assert.deepEqual(await ask(x, 'app()', 'sharedworker'), seeded('http://h/x.js', undefined, 1, 'x', 'http://h/x.js', tx));
  assert.deepEqual(heard, [...Array(5).fill(['http://h/s.js', 'continued']), ['http://h/x.js', 'continued']]);
  assert.match(unplacedLine('t', 'http://h/s.js', 'continued'), /^keploy: in t, the Shared Worker at http:\/\/h\/s\.js draws the browser's own random numbers, and so does each worker it starts, so their draws may differ at replay: a route of the test's own sent the Shared Worker's script on with a URL, method, headers or post data of its own .* have that route continue or fall back with no options for the Shared Worker's script to seed it\.$/);
  // Its own URL (fragment aside) or method given back, as the request has
  // them, seeds it; another method, or post data, does not.
  heard.length = 0;
  mine = (route) => route.continue({ url: route.request().url(), method: route.request().method() });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), seeded('http://h/s.js', undefined, 8, 's', 'http://h/s.js', ts));
  mine = (route) => route.continue({ url: 'http://h/s.js#a' });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), seeded('http://h/s.js#a', undefined, 9, 's', 'http://h/s.js', ts));
  mine = (route) => route.continue({ method: 'POST' });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('http://h/s.js', undefined, 'app()'));
  mine = (route) => route.continue({ postData: 'x' });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('http://h/s.js', undefined, 'app()'));
  mine = (route) => route.continue({ url: 'not a url' });
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('not a url', undefined, 'app()'));
  assert.deepEqual(heard, Array(3).fill(['http://h/s.js', 'continued']));
  // Two routes: the last one's options win. A page route's fallback with
  // the browser's own headers, then a context route's continue that adds one.
  heard.length = 0;
  mine = (route) => route.fallback({ headers: sent('sharedworker') });
  await context.route(() => true, (route) => route.continue({ headers: auth('sharedworker') }));
  assert.deepEqual(await ask(s, 'app()', 'sharedworker'), whole('http://h/s.js', auth('sharedworker'), 'app()'));
  assert.deepEqual(heard, [['http://h/s.js', 'continued']]);
});

test('workerRoutes answers a Web Worker\'s script with the app\'s script it fetched, its seeding\'s load ahead of it, under any Referrer-Policy: the test\'s route sees the worker\'s script once, keploy answers its seeding at its p or q mark only, and a load at the app\'s URL after it is the app\'s own, to the test\'s routes; an answer not ok goes as given; a Shared Worker whose script a route continues at another query gets that answer, whole, and is named', async () => {
  const { r, context } = routed();
  const answered = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()) });
  const page = r.page();
  const hits = [];
  await page.route(() => true, (route) => { hits.push(route.request().url()); return route.continue(); });
  const app = (policy, status = 200, body = 'app()') => answerOf(status, body, { 'content-type': 'text/javascript', ...(policy === undefined ? {} : { 'referrer-policy': policy }) });
  const start = (m, policy, status, body) => r.ask(m, app(policy, status, body), { type: 'script', headers: { referer: 'http://h/pg', 'sec-fetch-dest': 'worker' } }, page);
  const load = (url, type, dest) => r.ask(url, null, { type, headers: dest === undefined ? {} : { 'sec-fetch-dest': dest } }, page);
  const headers = (policy) => ({ 'content-type': 'text/javascript', ...(policy === undefined ? {} : { 'referrer-policy': policy }) });
  const tw = 'd1'.repeat(16);
  const tm = 'd2'.repeat(16);
  const w = markWorker('http://h/w.js', 'w', tw);
  const m = markWorker('http://h/m.js', 'm', tm);
  for (const [i, policy] of [undefined, 'no-referrer', 'origin', 'strict-origin'].entries()) {
    assert.deepEqual(await start(w, policy), [['fetch', 'http://h/w.js'], ['fulfill', { status: 200, headers: headers(policy), body: `importScripts(${JSON.stringify(markWorker('http://h/w.js', 'q', tw, i))});app()\n//# sourceURL=http://h/w.js\n` }]], String(policy));
    assert.deepEqual(await start(m, policy, 200, 'import "./a.js";\nb()'), [['fetch', 'http://h/m.js'], ['fulfill', { status: 200, headers: headers(policy), body: `import ${JSON.stringify(markWorker('http://h/m.js', 'p', tm, i))};import "./a.js";\nb()\n//# sourceURL=http://h/m.js\n` }]], String(policy));
  }
  assert.deepEqual(hits, Array(4).fill(['http://h/w.js', 'http://h/m.js']).flat());
  // Nothing is kept: a load at the app's URL, of any kind, is no seeding's.
  for (const u of ['http://h/w.js', 'http://h/m.js']) assert.equal(r.match(new URL(u)), false);
  for (const [type, dest] of [['other'], ['script', 'script'], ['script'], ['script', 'worker']]) {
    assert.deepEqual(await load('http://h/w.js', type, dest), [['continue', 'http://h/w.js']]);
  }
  // The seedings, at their marks, are keploy's, past the test's routes.
  assert.deepEqual(await load(markWorker('http://h/w.js', 'q', tw, 1), 'other'), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(tw, 1, 'w') }]]);
  assert.deepEqual(await load(markWorker('http://h/m.js', 'p', tm, 3), 'script', 'worker'), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(tm, 3, 'm') }]]);
  assert.equal(hits.length, 12);
  assert.equal(answered.length, 10);
  // An answer not ok goes to the worker as the server gave it.
  const x = markWorker('http://h/x.js', 'w', 'd6'.repeat(16));
  assert.deepEqual(await start(x, undefined, 404), [['fetch', 'http://h/x.js'], ['fulfill', { status: 404, headers: headers(), body: 'app()' }]]);
  // A Shared Worker's script a route continues at another query: the
  // answer to that, whole, unseeded, and named.
  const two = routed();
  const heard = [];
  await workerRoutes(two.context, { routed: (at, why) => heard.push([at, why]) });
  const p2 = two.r.page();
  await p2.route(() => true, (route) => route.continue({ url: 'http://h/s.js?v=2' }));
  const s = markWorker('http://h/s.js', 's', 'd5'.repeat(16));
  assert.deepEqual(await two.r.ask(s, app(), { type: 'script', headers: { 'sec-fetch-dest': 'sharedworker' } }, p2), [['fetch', 'http://h/s.js?v=2'], ['fulfill', { status: 200, headers: headers(), body: 'app()' }]]);
  assert.deepEqual(heard, [['http://h/s.js', 'continued']]);
  // Where the route reaches a Web Worker's own workers (reach: WebKit),
  // the seeding it serves at a p or q mark starts them seeded too.
  const three = routed();
  await workerRoutes(three.context, {}, 'webkit');
  assert.notEqual(workerScript(tw, 0, 'w', true), workerScript(tw, 0, 'w'));
  assert.deepEqual(await three.r.ask(markWorker('http://h/w.js', 'q', tw, 0), undefined, { type: 'other', headers: {} }), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(tw, 0, 'w', true) }]]);
  assert.deepEqual(await three.r.ask(markWorker('http://h/m.js', 'p', tm, 0), undefined, { type: 'script', headers: {} }), [['fulfill', { status: 200, contentType: 'text/javascript', body: workerScript(tm, 0, 'm', true) }]]);
});

test('workerAnswer: a Web Worker\'s is the app\'s script with its seeding\'s load first, on its first line (after a hashbang line), strict when the app\'s directive prologue says \'use strict\', then a sourceURL of the app\'s URL unless the app\'s script names one; useStrict reads a prologue as the language does', () => {
  const t = 'ee'.repeat(16);
  const q = JSON.stringify(markWorker('http://h/w.js?a=1#f', 'q', t, 4));
  const p = JSON.stringify(markWorker('http://h/m.js', 'p', t, 4));
  const tail = '\n//# sourceURL=http://h/w.js?a=1\n';
  const w = (src) => workerAnswer(t, 4, 'w', 'http://h/w.js?a=1#f', true, src);
  assert.equal(w('a()\nb()'), `importScripts(${q});a()\nb()${tail}`);
  assert.equal(w('\'use strict\';\na()'), `"use strict";importScripts(${q});'use strict';\na()${tail}`);
  assert.equal(w('#!/x\r\n"use strict"\na()'), `#!/x\r\n"use strict";importScripts(${q});"use strict"\na()${tail}`);
  assert.equal(w('#!/x'), `#!/x\nimportScripts(${q});${tail}`);
  assert.equal(w('a()\n//# sourceURL=mine.js'), `importScripts(${q});a()\n//# sourceURL=mine.js`);
  assert.equal(w('a() /*@ sourceURL=mine.js */'), `importScripts(${q});a() /*@ sourceURL=mine.js */`);
  assert.equal(workerAnswer(t, 4, 'm', 'http://h/m.js', true, 'import "./a.js";\nb()'), `import ${p};import "./a.js";\nb()\n//# sourceURL=http://h/m.js\n`);
  assert.equal(workerAnswer(t, 4, 'm', 'http://h/m.js', true, '#!/x\nb()'), `#!/x\nimport ${p};b()\n//# sourceURL=http://h/m.js\n`);
  // Each line of the app's keeps its number.
  assert.equal(w('a\nb\nc').split('\n').slice(0, 3).map((l) => l.slice(-1)).join(''), 'abc');
  for (const [src, strict] of [
    ['\'use strict\'', true], ['"use strict"; a()', true], ['/* c */ // d\n "use asm"\n\'use strict\'\nx', true], ['\ufeff  "a"; "b";\n"use strict";', true],
    ['#!/usr/bin/env node\n\'use strict\';', true], ['"use strict" /* c\n */ a()', true],
    ['"use strict" + a', false], ['a(); "use strict";', false], ['"use\\x20strict";', false], ['"a" + b; "use strict";', false],
    ['', false], ['"use strict', false], ['"use\nstrict"', false], ['#!/x', false], ['`use strict`;', false], ['// "use strict"', false], ['"x\\"y"; "use strict"', true],
    // U+2028 and U+2029 may stand in a string; a directive after one still counts.
    ['"a b"; "use strict"', true], ['\'a b\'\n\'use strict\'', true],
    // A line comment that ends the source ends the directive's statement.
    ['"use strict" // c', true],
    // U+2028 and U+2029 end a line as a line feed does, so the directive after one is a statement of its own.
    ['"a"\u2028"use strict"', true], ['"a"\u2029"use strict"', true], ['"a" "use strict"', false],
  ]) assert.equal(useStrict(src), strict, JSON.stringify(src));
});

test('a Web Worker\'s seeding: an ErrorEvent\'s filename at the worker\'s own marked URL shows it with no mark; another, one that is no string and the getter\'s own error stay as they were; a Shared Worker\'s seeding leaves it as it is', () => {
  const t = 'ab'.repeat(16);
  for (const kind of ['w', 'm', 's']) {
    const href = markWorker('http://h/w.js?a=1', kind, t);
    class ErrorEvent {}
    const w = workerAt(href, '', { ErrorEvent });
    w.run('Object.defineProperty(ErrorEvent.prototype, \'filename\', { get() { if (!(this instanceof ErrorEvent)) throw new TypeError(\'Illegal invocation\'); return this.f; }, enumerable: true, configurable: true });');
    w.run(workerScript(t, 0, kind));
    const read = (f) => w.run(`(() => { const e = new ErrorEvent(); e.f = ${JSON.stringify(f)}; return e.filename; })()`);
    assert.equal(read(href), kind === 's' ? href : 'http://h/w.js?a=1', kind);
    assert.equal(read(`${href}#h`), kind === 's' ? `${href}#h` : 'http://h/w.js?a=1#h', kind);
    for (const f of ['http://h/o.js', 'http://h/null.js', markWorker('http://h/w.js?a=1', kind === 'w' ? 'm' : 'w', t), markWorker('http://h/w.js', kind, 'cd'.repeat(16)), 7]) assert.equal(read(f), f, `${kind} ${f}`);
    assert.equal(w.run('(() => { try { return Object.getOwnPropertyDescriptor(ErrorEvent.prototype, \'filename\').get.call({}); } catch (e) { return e.message; } })()'), 'Illegal invocation', kind);
  }
});


test('workerRoutes answers a Shared Worker\'s script with workerAnswer, a module one whose policy refuses data: with its seeding in the answer; each request it fulfills is answered', async () => {
  const { r, context } = routed();
  const answered = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()) });
  const t = '67'.repeat(16);
  const headers = { 'content-type': 'text/javascript', 'x-a': '1' };
  const s0 = markWorker('http://h/s.js', 's', t);
  assert.deepEqual(await r.ask(s0, answerOf(200, '\ufeffapp()')), [['fetch', 'http://h/s.js'], ['fulfill', { status: 200, headers, body: workerAnswer(t, 0, 's', 'http://h/s.js') }]]);
  assert.equal((await r.ask(s0, answerOf(200, 'app()')))[1][1].body, workerAnswer(t, 1, 's', 'http://h/s.js'));
  const x0 = markWorker('http://h/m.js', 'x', t.replace('6', '8'));
  assert.equal((await r.ask(x0, answerOf(200, 'export {}')))[1][1].body, workerAnswer(t.replace('6', '8'), 0, 'x', 'http://h/m.js', true));
  const policy = { 'content-type': 'text/javascript', 'content-security-policy': "script-src 'self'" };
  const x1 = markWorker('http://h/c.js', 'x', t.replace('6', '9'));
  assert.deepEqual(await r.ask(x1, answerOf(200, '\ufeffexport {}', policy)), [['fetch', 'http://h/c.js'], ['fulfill', { status: 200, headers: policy, body: workerAnswer(t.replace('6', '9'), 0, 'x', 'http://h/c.js', false) }]]);
  assert.notEqual(workerAnswer(t, 0, 'x', 'http://h/c.js', false), workerAnswer(t, 0, 'x', 'http://h/c.js', true));
  // A classic one is not refused by a policy: it imports the app's script.
  const d0 = markWorker('http://h/d.js', 's', t.replace('6', 'a'));
  assert.equal((await r.ask(d0, answerOf(200, 'app()', policy)))[1][1].body, workerAnswer(t.replace('6', 'a'), 0, 's', 'http://h/d.js'));
  // Each at the URL the app asked for: keploy's first route handed it on so.
  assert.deepEqual(answered, [s0, s0, x0, x1, d0].map((u) => workerMark(u).url));
  // Not answered: what falls back.
  await r.ask(`http://h/m.js?__keploy_worker=s.${t}.3`);
  assert.equal(answered.length, 5);
});

test('a worker\'s seeding: its fetch and Request ask for its script\'s own URL with no mark, and a fetch whose referrer the browser would pick names that URL with no mark; another URL, a given referrer, a Request with a referrer or policy of its own, what is no string and a worker with no mark are left as they are; what they refuse reaches the caller with no frame at a marked URL', async () => {
  const t = 'cd'.repeat(16);
  const plain = 'http://h/w.js?a=1';
  const href = markWorker(plain, 'w', t);
  // A Request that keeps what it was made with, and a fetch that keeps what
  // it was given; each refuses 'bad' with an error whose stack has a frame
  // at a marked URL.
  const marked = (m) => { const e = {}; Object.defineProperty(e, 'stack', { value: `E: ${m}\n    at f (${href.replace('=w.', '=q.')}.0:1:2)\n    at g (http://h/a.js:3:4)`, writable: true, configurable: true }); return e; };
  const given = [];
  const fakes = () => ({
    URL,
    Request: class Request {
      constructor(u, init) {
        if (u === 'bad') throw marked('request');
        this.n = arguments.length;
        this.u = u;
        this.referrer = init && init.referrer !== undefined ? init.referrer : 'about:client';
        this.referrerPolicy = init && init.referrerPolicy !== undefined ? init.referrerPolicy : '';
      }
    },
    fetch: function fetch(...a) { given.push({ self: this, a }); return a[0] === 'bad' ? Promise.reject(marked('fetch')) : Promise.resolve('ok'); },
  });
  const w = workerAt(href, workerScript(t, 0, 'w'), fakes());
  const last = async (code) => { given.length = 0; assert.equal(await w.run(code), 'ok', code); assert.equal(given.length, 1, code); return given[0].a; };
  const ref = (a) => [a.length, a[0], a[1] && a[1].referrer];
  // At the script's own URL (an empty URL, a fragment alone): no mark, and
  // the browser's referrer named with no mark.
  assert.deepEqual(ref(await last('fetch(\'\')')), [2, plain, plain]);
  assert.deepEqual(ref(await last('fetch(\'#f\', null)')), [2, `${plain}#f`, plain]);
  // Another URL, one that is no URL, and what is no string go as given.
  assert.deepEqual(ref(await last('fetch(\'x.js\')')), [2, 'x.js', plain]);
  assert.deepEqual(ref(await last('fetch(\'http://[\')')), [2, 'http://[', plain]);
  assert.equal((await last('globalThis.u = { toString() { return \'\'; } }; fetch(u)'))[0], w.run('u'));
  // An init: its own referrer kept, its other members read from it whole
  // (a getter's this is the init), what follows it kept; an init that is a
  // function is one too; an init that is no object goes as given.
  assert.deepEqual(ref(await last('fetch(\'\', { referrer: \'http://h/r\' })')), [2, plain, 'http://h/r']);
  const m = await last('globalThis.o = { get method() { return this === o ? \'POST\' : \'other\'; } }; fetch(\'a\', o, \'more\')');
  assert.deepEqual([m.length, m[1].method, m[1].body, m[1].referrer, m[2]], [3, 'POST', undefined, plain, 'more']);
  const f = await last('fetch(\'a\', Object.assign(function () {}, { method: \'PATCH\' }))');
  assert.deepEqual([f[1].method, f[1].referrer], ['PATCH', plain]);
  assert.deepEqual(await last('fetch(\'a\', 5)'), ['a', 5]);
  // fetch is called on what the caller called it on.
  await last('globalThis.th = {}; fetch.call(th, \'a\')');
  assert.equal(given[0].self, w.run('th'));
  // A Request: made at the script's own URL with no mark; given to fetch,
  // its referrer named with no mark only when it left it to the browser
  // with the default policy.
  assert.deepEqual(['new Request(\'\').u', 'new Request(\'#f\').u', 'new Request(\'x.js\').u', 'new Request().n'].map((c) => w.run(c)), [plain, `${plain}#f`, 'x.js', 0]);
  assert.equal(w.run('new Request(\'\') instanceof Request && Request.prototype.constructor === Request && Request.name'), 'Request');
  const r = await last('globalThis.r = new Request(\'a\'); fetch(r)');
  assert.deepEqual([r.length, r[0] === w.run('r'), r[1].referrer], [2, true, plain]);
  assert.deepEqual([(await last('fetch(new Request(\'a\'), { method: \'PUT\' })'))[1].method, given[0].a[1].referrer], ['PUT', plain]);
  for (const init of ['{ referrer: \'http://h/r\' }', '{ referrerPolicy: \'no-referrer\' }', '{ referrer: \'about:client\', referrerPolicy: \'origin\' }']) {
    assert.equal((await last(`fetch(new Request('a', ${init}))`)).length, 1, init);
  }
  // What they refuse: no frame at a marked URL on its stack.
  await assert.rejects(w.run('fetch(\'bad\')'), (e) => e.stack === 'E: fetch\n    at g (http://h/a.js:3:4)');
  assert.equal(w.run('try { new Request(\'bad\'); } catch (e) { e.stack }'), 'E: request\n    at g (http://h/a.js:3:4)');
  // A worker with no mark, or whose location cannot be read, keeps the
  // browser's own fetch and Request; one with no fetch, or no Request,
  // gets none.
  const plainFakes = fakes();
  const p = workerAt(plain, workerScript(t, 0, 'w'), plainFakes);
  assert.equal(p.run('fetch') === plainFakes.fetch && p.run('Request') === plainFakes.Request, true);
  const qFakes = fakes();
  const q = workerAt(href, '', qFakes);
  q.run('Object.defineProperty(WorkerLocation.prototype, \'href\', { get() { throw new Error(\'no\'); }, configurable: true });');
  q.run(workerScript(t, 0, 'w'));
  assert.equal(q.run('fetch') === qFakes.fetch && q.run('Request') === qFakes.Request, true);
  const { fetch: noFetch, ...rest } = fakes();
  const { Request: noRequest, ...rest2 } = fakes();
  assert.deepEqual([workerAt(href, workerScript(t, 0, 'w'), rest).run('typeof fetch + typeof Request'), workerAt(href, workerScript(t, 0, 'w'), rest2).run('typeof fetch + typeof Request')],
    [`undefined${typeof noFetch}`, `${typeof noRequest}undefined`]);
});

test('workerRoutes keeps its route on a page and on the context through the test\'s unroute and unrouteAll: with Playwright\'s own way to take some routes off, unrouteAll takes the test\'s alone, with the behavior it gives, and lets go of its HARs; without it, keploy\'s are added again, ahead', async () => {
  const { context, page, log } = played();
  await workerRoutes(context);
  const p = page();
  await turn();
  const k = p._routes[0];
  assert.equal(p._routes.length, 1);
  const h = async (route) => route.continue();
  const g = async (route) => route.continue();
  await p.route(uwAt, h);
  await p.route(uwAt, g);
  assert.deepEqual(p._routes.map((x) => x.handler).slice(1), [g, h]);
  await p.unroute(uwAt, g);
  await p.unroute(uwAt, h);
  assert.equal(p._routes.length, 1);
  for (const behavior of [undefined, 'default', 'wait', 'ignoreErrors']) {
    await p.route(uwAt, h);
    log.length = 0;
    await p.unrouteAll(behavior === undefined ? undefined : { behavior });
    assert.deepEqual(log, [['page', 'off', 1, 1, behavior]], String(behavior));
    assert.equal(p._routes.length, 1, String(behavior));
    assert.equal(p._routes[0].match(new URL(markWorker('http://h/uw.js', 'w', 'f1'.repeat(16)))), true);
  }
  assert.equal(p.hars, 4);
  assert.notEqual(p._routes[0], k);
  await context.route(uwAt, h);
  log.length = 0;
  await context.unrouteAll({ behavior: 'wait' });
  // keploy's two routes there (its first and its last) stay.
  assert.deepEqual(log, [['context', 'off', 1, 2, 'wait']]);
  assert.equal(context.hars, 1);
  // Without Playwright's own way: keploy's added again after the test's.
  const { r, context: c2 } = routed();
  await workerRoutes(c2);
  const q = r.page(true);
  await turn();
  await q.route('**/w.js', h);
  await q.unrouteAll();
  assert.equal(q.routes.length, 1);
  // A page that shows no list of its routes: its own unrouteAll takes them
  // off, whatever else it shows, and keploy's is added again.
  const bare = r.page();
  bare._unrouteInternal = async () => { throw new Error('not this way'); };
  await turn();
  await bare.route('**/w.js', h);
  await bare.unrouteAll();
  assert.equal(bare.routes.length, 1);
  assert.equal(bare.routes[0].match(new URL(markWorker('http://h/w.js', 'w', 'f1'.repeat(16)))), true);
  assert.equal(q.routes[0].match(new URL(markWorker('http://h/w.js', 'w', 'f1'.repeat(16)))), true);
  const n = c2.routes.length;
  await c2.unrouteAll();
  assert.equal(c2.routes.length, n);
});

// A fake of Playwright's own routing, past its API: a page and the context
// keep their routes as Playwright does (_routes: each one's matcher, its
// handler and the requests it is handling now), take some off with
// _unrouteInternal ('wait' waits for what they handle; after
// 'ignoreErrors' an error a handler throws is dropped and the request goes
// on to the next route) and let go of their HARs. A request is handled
// once, as by Playwright: each route gets it to handle in turn, and once
// one answered it, continue, fulfill, abort and fallback throw Playwright's
// error; with inner, Playwright's own answers past its API (_innerFulfill,
// _innerContinue: sent on) answer it and leave it to the route that holds
// it, whose continue, fulfill or abort then fails at the browser's end
// (route.<call>: ...). After drop (the browser dropped the request: a
// worker terminated as its script loads) every answer throws. What the request saw is in did: keploy's fetch, its seeded answer,
// another answer, an error a handler threw ('threw', or 'dropped' after
// 'ignoreErrors'), a handler that returned with no answer ('unanswered'),
// or the URL the browser sent it to when no route answered it ('sent').
const uwAt = (u) => u.pathname === '/uw.js';
function played(inner = true, moved = false) {
  const log = [];
  const listeners = [];
  const target = (name) => {
    const t = { _routes: [], hars: 0 };
    t.route = async (match, handler) => { t._routes.unshift({ match, url: match, handler, _activeInvocations: new Set() }); };
    t.unroute = async (match, handler) => {
      const removed = t._routes.filter((x) => x.match === match && (handler === undefined || x.handler === handler));
      await t._unrouteInternal(removed, t._routes.filter((x) => !removed.includes(x)), 'default');
    };
    t._unrouteInternal = async (removed, remaining, behavior) => {
      t._routes = remaining;
      log.push([name, 'off', removed.length, remaining.length, behavior]);
      for (const x of removed) x.drop = behavior === 'ignoreErrors';
      if (behavior === 'wait') await Promise.all(removed.flatMap((x) => [...x._activeInvocations].map((i) => i.complete)));
    };
    t._disposeHarRouters = () => { t.hars++; };
    t.unrouteAll = async (o) => { await t._unrouteInternal(t._routes, [], o?.behavior); t._disposeHarRouters(); };
    return t;
  };
  const context = target('context');
  const pages = [];
  context.pages = () => pages.slice();
  context.on = (event, f) => { if (event === 'page') listeners.push(f); };
  const page = () => {
    const p = target('page');
    pages.push(p);
    for (const f of listeners) f(p);
    return p;
  };
  // A request from page p (null: from no page) at url; fetch's answer waits
  // for held.
  const send = (url, p, held = Promise.resolve()) => {
    const did = [];
    let at = url;
    let handling = false;
    let here = false;
    let answered = false;
    let dropped = false;
    const request = { url: () => at, resourceType: () => 'script', headers: () => ({}), method: () => 'GET', postData: () => null, frame: () => { if (p === null) throw new Error('no frame'); return { page: () => p }; } };
    const kind = (o) => (String(o.body).startsWith('importScripts(') ? 'seeded' : 'fulfill');
    const serve = (call, what) => {
      if (dropped) throw new Error(`route.${call}: Request context disposed.`);
      if (answered) throw new Error(`route.${call}: Route is already handled!`);
      answered = true;
      did.push(what);
    };
    const take = (call, what) => {
      if (!handling) throw new Error('Route is already handled!');
      serve(call, what);
      handling = false;
      here = true;
    };
    const route = {
      request: () => request,
      fetch: async () => {
        did.push('fetch');
        await held;
        return moved ? { ...answerOf(302, '', { location: 'v2/uw.js' }), url: () => at } : answerOf(200, 'app()');
      },
      fulfill: async (o) => take('fulfill', kind(o)),
      continue: async () => take('continue', 'continue'),
      abort: async () => take('abort', 'abort'),
      fallback: async (o) => {
        if (!handling) throw new Error('Route is already handled!');
        handling = false;
        if (o?.url !== undefined) at = o.url;
      },
    };
    if (inner) {
      route._innerFulfill = async (o) => serve('fulfill', kind(o));
      route._innerContinue = async (fallback) => serve('continue', fallback === true ? ['sent', at] : ['sent', at, 'continued']);
      route._channel = { abort: async (o) => serve('abort', ['stopped', o.errorCode]) };
    }
    const end = (async () => {
      for (const t of p === null ? [context] : [p, context]) {
        for (const x of t._routes.slice()) {
          if (!x.match(new URL(at))) continue;
          handling = true;
          here = false;
          let complete = () => {};
          const inv = { route, complete: new Promise((res) => { complete = res; }) };
          x._activeInvocations.add(inv);
          try {
            await x.handler(route, request);
          } catch (e) {
            did.push([x.drop ? 'dropped' : 'threw', e.message]);
            if (x.drop) continue;
            return;
          } finally {
            x._activeInvocations.delete(inv);
            complete();
          }
          if (here) return;
          if (handling) {
            did.push('unanswered');
            return;
          }
        }
      }
      if (!answered) did.push(['sent', at]);
    })();
    return { did, end, drop: () => { dropped = true; } };
  };
  return { context, page, send, log };
}

// The test's route on a page takes a Web Worker's script load keploy handed
// on, then the test takes that route off (the page's last of the test's:
// unroute, or unrouteAll with behavior), then answers the load (how), or
// before (first).
async function takenOff(how, { first = false, off = (p, t) => p.unroute(uwAt, t), other = false, at = markWorker('http://h/uw.js', 'w', 'e1'.repeat(16)), inner = true, moved = false, engine = 'chromium' } = {}) {
  const { context, page, send } = played(inner, moved);
  await workerRoutes(context, {}, engine);
  const p = page();
  await turn();
  if (other) await p.route(() => true, (route) => route.fallback());
  let release = () => {};
  const held = new Promise((res) => { release = res; });
  let early = null;
  const call = (route) => (how === 'fulfill' ? route.fulfill({ body: 'own' }) : route[how]());
  const t = async (route) => {
    const done = first ? call(route) : null;
    const going = off(p, t);
    await turn();
    release();
    await going;
    early = x.did.slice();
    await (first ? done : call(route));
  };
  await p.route(uwAt, t);
  const x = send(at, p, held);
  await x.end;
  return { did: x.did, early };
}

test('workerRoutes, when the test takes off a page\'s last route of its own while that route holds a worker script\'s load keploy handed on: keploy, whose route stays on the page, answers it, seeded, before the unroute or unrouteAll returns, as Playwright sends such a request on; the route\'s continue, fulfill or abort after that fails with Playwright\'s error, and its fallback goes on, as with no keploy', async () => {
  for (const how of ['continue', 'fulfill', 'abort']) {
    const x = await takenOff(how);
    assert.deepEqual(x.early, ['fetch', 'seeded'], how);
    assert.deepEqual(x.did, ['fetch', 'seeded', ['threw', `route.${how}: Route is already handled!`]], how);
  }
  const f = await takenOff('fallback');
  assert.deepEqual(f.did, ['fetch', 'seeded']);
  // unrouteAll with any behavior; after 'ignoreErrors' the error is dropped.
  for (const [behavior, how] of [[undefined, 'continue'], ['default', 'fulfill'], ['ignoreErrors', 'abort'], ['ignoreErrors', 'fallback']]) {
    const x = await takenOff(how, { off: (p) => p.unrouteAll(behavior === undefined ? undefined : { behavior }) });
    assert.deepEqual(x.early, ['fetch', 'seeded'], `${behavior} ${how}`);
    const after = how === 'fallback' ? [] : [[behavior === 'ignoreErrors' ? 'dropped' : 'threw', `route.${how}: Route is already handled!`]];
    assert.deepEqual(x.did, ['fetch', 'seeded', ...after], `${behavior} ${how}`);
  }
  // Any other request the route held is sent on, as Playwright sends it.
  const o = await takenOff('continue', { at: 'http://h/uw.js' });
  assert.deepEqual(o.did, [['sent', 'http://h/uw.js'], ['threw', 'route.continue: Route is already handled!']]);
  // A Playwright with no answers past its API: keploy answers through the
  // route's own, so the route's later call fails at once, and a fallback
  // does nothing.
  const c = await takenOff('continue', { inner: false });
  assert.deepEqual(c.did, ['fetch', 'seeded', ['threw', 'Route is already handled!']]);
  const b = await takenOff('fallback', { inner: false });
  assert.deepEqual(b.did, ['fetch', 'seeded']);
  const n = await takenOff('continue', { inner: false, at: 'http://h/uw.js' });
  assert.deepEqual(n.did, ['continue', ['threw', 'Route is already handled!']]);
  // A worker's script the server redirects: WebKit sends it on as Playwright
  // sends on a request it held (no 'continued'), Chromium stops it, Firefox
  // gets the server's redirect, each past Playwright's API, so the route's
  // later continue fails at the browser's end; with no such answers, through
  // the route's own, so it fails at once.
  // Each answer ends the load, so the route's later call goes on.
  for (const [engine, then] of [['webkit', ['sent', 'http://h/uw.js']], ['chromium', ['stopped', 'blockedbyclient']], ['firefox', 'fulfill']]) {
    const m = await ends(takenOff('continue', { moved: true, engine }));
    assert.notEqual(m, 'still waiting', engine);
    assert.deepEqual(m.early, ['fetch', then], engine);
    assert.deepEqual(m.did, ['fetch', then, ['threw', 'route.continue: Route is already handled!']], engine);
    const own = await ends(takenOff('continue', { moved: true, engine, inner: false }));
    assert.notEqual(own, 'still waiting', `${engine} own`);
    assert.deepEqual(own.did, ['fetch', { webkit: 'continue', chromium: 'abort', firefox: 'fulfill' }[engine], ['threw', 'Route is already handled!']], `${engine} own`);
  }
});

test('workerRoutes, when the test takes a route off that began to answer a worker script\'s load (continue, fulfill, abort), or while the page keeps a route of the test\'s, or with unrouteAll\'s \'wait\' from outside the route: that answer goes on as with no keploy, once, and the unroute waits for it', async () => {
  for (const how of ['continue', 'fulfill', 'abort']) {
    const x = await takenOff(how, { first: true });
    const own = how === 'continue' ? ['fetch', 'seeded'] : [how];
    assert.deepEqual(x.early, own, how);
    assert.deepEqual(x.did, own, how);
  }
  // Another route of the test's stays on the page: Playwright sends
  // nothing on, so the route's continue answers it.
  const kept = await takenOff('continue', { other: true });
  assert.deepEqual(kept.early, []);
  assert.deepEqual(kept.did, ['fetch', 'seeded']);
  // unrouteAll's 'wait', from outside the route: it waits for the route,
  // whose continue answers the load.
  const { context, page, send } = played();
  await workerRoutes(context);
  const p = page();
  await turn();
  let go = () => {};
  const going = new Promise((res) => { go = res; });
  let reached = () => {};
  const at = new Promise((res) => { reached = res; });
  await p.route(uwAt, async (route) => { reached(); await going; await route.continue(); });
  const x = send(markWorker('http://h/uw.js', 'w', 'e2'.repeat(16)), p);
  await at;
  const off = p.unrouteAll({ behavior: 'wait' });
  await turn();
  assert.deepEqual(x.did, []);
  go();
  await off;
  await x.end;
  assert.deepEqual(x.did, ['fetch', 'seeded']);
});

test('workerRoutes: a route of the test\'s that calls fulfill, abort, fallback or continue while keploy still answers its continue gets Playwright\'s error once that answer ended, and the load is answered once; one the browser dropped while keploy fetched its script (a worker terminated as it loads) is still counted answered, and the route\'s next call waits no more', async () => {
  for (const [how, drop] of [['fulfill', false], ['abort', false], ['fallback', false], ['continue', false], ['abort', true]]) {
    const label = `${how}${drop ? ' dropped' : ''}`;
    const answered = [];
    const { context, page, send } = played();
    await workerRoutes(context, { answered: (q) => answered.push(q.url()) });
    const p = page();
    await turn();
    let release = () => {};
    const held = new Promise((res) => { release = res; });
    let first = null;
    let second = null;
    await p.route(uwAt, async (route) => {
      first = route.continue().then(() => 'ok', (e) => e.message);
      second = (how === 'fulfill' ? route.fulfill({ body: 'own' }) : route[how]()).then(() => 'ok', (e) => e.message);
      await turn();
      if (drop) x.drop();
      release();
      await first;
    });
    const x = send(markWorker('http://h/uw.js', 'w', 'e4'.repeat(16)), p, held);
    await x.end;
    // Before the second call is awaited: it waits on the first's end.
    assert.deepEqual(answered, ['http://h/uw.js'], label);
    assert.deepEqual(x.did, drop ? ['fetch', 'unanswered'] : ['fetch', 'seeded'], label);
    assert.equal(await first, drop ? 'route.fulfill: Request context disposed.' : 'ok', label);
    assert.equal(await second, drop ? 'route.abort: Request context disposed.' : 'Route is already handled!', label);
  }
});

test('workerRoutes, when the test takes its context\'s last route off while it holds a worker script\'s load: keploy answers one from a page with no route of the test\'s (one keploy has not seen yet too), or from no page (Playwright sends those on), and leaves one from a page that has one (Playwright sent it through that page) to the route', async () => {
  for (const [from, sent] of [['bare', true], ['routed', false], ['none', true], ['unseen', true]]) {
    const { context, page, send } = played();
    await workerRoutes(context);
    const p = from === 'unseen' ? { _routes: [] } : page();
    await turn();
    if (from === 'routed') await p.route(() => true, (route) => route.fallback());
    let early = null;
    const c = async (route) => {
      await context.unroute(uwAt, c);
      early = x.did.slice();
      await route.continue();
    };
    await context.route(uwAt, c);
    const x = send(from === 'none' ? 'http://h/uw.js' : markWorker('http://h/uw.js', 'w', 'e3'.repeat(16)), from === 'none' ? null : p);
    await x.end;
    assert.deepEqual(early, sent ? (from === 'none' ? [['sent', 'http://h/uw.js']] : ['fetch', 'seeded']) : [], from);
    const after = sent ? [['threw', 'route.continue: Route is already handled!']] : [];
    assert.deepEqual(x.did, [...(from === 'none' ? [['sent', 'http://h/uw.js']] : ['fetch', 'seeded']), ...after], from);
  }
});

test('workerRoutes: a request at a worker script\'s URL that keploy handed nothing at reaches the context\'s routes past keploy\'s, unchanged', async () => {
  const { r, context } = routed();
  await workerRoutes(context);
  const p = r.page(true);
  await p.route(() => true, (route) => route.fallback());
  assert.deepEqual(await r.ask(markWorker('http://h/k.js', 'w', 'f2'.repeat(16)), answerOf(200, 'app()'), { type: 'script', headers: {} }, p), [['fetch', 'http://h/k.js'], ['fulfill', { status: 200, headers: { 'content-type': 'text/javascript', 'x-a': '1' }, body: `importScripts(${JSON.stringify(markWorker('http://h/k.js', 'q', 'f2'.repeat(16), 0))});app()\n//# sourceURL=http://h/k.js\n` }]]);
  // The app's own fetch at that URL, from another page with no route.
  assert.deepEqual(await r.ask('http://h/k.js', null, { type: 'fetch', headers: {} }, r.page(true)), [['fallback']]);
});

test('workerAnswer keeps the app\'s script\'s bytes: another charset\'s bytes, a byte order mark (UTF-8 or UTF-16) and a hashbang line keep their place, and keploy\'s statements are in the script\'s own encoding', () => {
  const t = 'ab'.repeat(16);
  const own = 'http://h/w.js';
  const q = `importScripts(${JSON.stringify(markWorker(own, 'q', t, 0))});`;
  const tail = `\n//# sourceURL=${own}\n`;
  const at = (bytes) => workerAnswer(t, 0, 'w', own, true, Buffer.from(bytes));
  const a = (x) => Buffer.from(x, 'latin1');
  assert.deepEqual(at([0x68, 0xe9]), Buffer.concat([a(q), Buffer.from([0x68, 0xe9]), a(tail)]));
  assert.deepEqual(at([0xef, 0xbb, 0xbf, 0x61]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), a(q), a('a'), a(tail)]));
  const le = at(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"use strict";a\u00e9()', 'utf16le')]));
  assert.deepEqual([...le.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(new TextDecoder('utf-16le').decode(le), `"use strict";${q}"use strict";a\u00e9()${tail}`);
  const be = at(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('#!/x\na()', 'utf16le').swap16()]));
  assert.deepEqual([...be.subarray(0, 2)], [0xfe, 0xff]);
  assert.equal(new TextDecoder('utf-16be').decode(be), `#!/x\n${q}a()${tail}`);
  assert.equal(new TextDecoder('utf-16le').decode(at(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('#!/x\r\na()', 'utf16le')]))), `#!/x\r\n${q}a()${tail}`);
  // In UTF-16, U+2028 and U+2029 are one code unit each, and end the hashbang line too.
  assert.equal(new TextDecoder('utf-16le').decode(at(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('#!/x\u2028a()', 'utf16le')]))), `#!/x\u2028${q}a()${tail}`);
  assert.equal(new TextDecoder('utf-16be').decode(at(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('#!/x\u2029a()', 'utf16le').swap16()]))), `#!/x\u2029${q}a()${tail}`);
  for (const [src, head] of [['#!/x\r\na\u00e9', '#!/x\r\n'], ['#!/x\ra', '#!/x\r'], ['#!/x\na', '#!/x\n'], ['#!/x\u2028a', '#!/x\u2028'], ['#!/x\u2029a', '#!/x\u2029'], ['\ufeff#!/x\na', '\ufeff#!/x\n']]) {
    assert.deepEqual(at(Buffer.from(src)), Buffer.concat([Buffer.from(head), a(q), Buffer.from(src.slice(head.length)), a(tail)]), JSON.stringify(src));
  }
  assert.deepEqual(at(Buffer.from('#!/x')), Buffer.concat([a(`#!/x\n${q}`), a(tail)]));
  assert.deepEqual(at(Buffer.from('#')), Buffer.concat([a(q), a('#'), a(tail)]));
  // Given text, it answers text: the same bytes read as UTF-8.
  assert.equal(workerAnswer(t, 0, 'w', own, true, '#!/x\u2028a\u00e9'), `#!/x\u2028${q}a\u00e9${tail}`);
  assert.deepEqual(withBytes(Buffer.from('a'), 'P;', ''), Buffer.from('P;a'));
});

test('oneLine: a worker\'s seeding on one line, ASCII, draws what it draws on its own lines, and keeps the worker\'s location free of the mark', () => {
  const t = 'ef'.repeat(16);
  for (const kind of ['w', 'm']) {
    for (const reach of [false, true]) {
      const s = workerScript(t, 3, kind, reach);
      const one = oneLine(s);
      assert.equal(/[\n\r\u2028\u2029]/.test(one), false);
      assert.equal(/[^\x00-\x7f]/.test(one), false);
      const href = markWorker('http://h/w.js?a=1', kind, t);
      assert.deepEqual(workerAt(href, one).draws(), workerAt(href, s).draws());
      assert.equal(workerAt(href, one).run('location.href'), 'http://h/w.js?a=1');
      assert.equal(workerAt(href, `"use strict";${one}`).run('location.href'), 'http://h/w.js?a=1');
    }
  }
  assert.equal(oneLine('a;\n  // c\n\n  b;'), 'a; b;');
});

test('workerRoutes answers a Web Worker whose script carries a Content-Security-Policy with its seeding on the script\'s first line, loading nothing of keploy\'s, and names a module one, whose seeding runs after its imports, once for each address', async () => {
  const { r, context } = routed();
  const late = [];
  await workerRoutes(context, { late: (at) => late.push(at) });
  const t = 'cd'.repeat(16);
  const policy = { 'content-type': 'text/javascript', 'content-security-policy': "default-src 'none'" };
  const w = await r.ask(markWorker('http://h/w.js', 'w', t), answerOf(200, '"use strict";app()', policy));
  assert.equal(w[1][1].body, `"use strict";${oneLine(workerScript(t, 0, 'w'))}"use strict";app()\n//# sourceURL=http://h/w.js\n`);
  assert.deepEqual(w[1][1].headers, policy);
  const s = await r.ask(markWorker('http://h/w.js', 'w', t), answerOf(200, 'app()', policy));
  assert.equal(s[1][1].body, `${oneLine(workerScript(t, 1, 'w'))}app()\n//# sourceURL=http://h/w.js\n`);
  assert.deepEqual(late, []);
  const m = await r.ask(markWorker('http://h/m.js', 'm', t), answerOf(200, 'import "./a.js";b()', policy));
  assert.equal(m[1][1].body, `${oneLine(workerScript(t, 2, 'm'))}import "./a.js";b()\n//# sourceURL=http://h/m.js\n`);
  assert.deepEqual(late, ['http://h/m.js']);
  // With no policy, keploy loads the seeding ahead of the imports, and says nothing.
  const m2 = await r.ask(markWorker('http://h/m.js', 'm', t), answerOf(200, 'b()'));
  assert.equal(m2[1][1].body, `import ${JSON.stringify(markWorker('http://h/m.js', 'p', t, 3))};b()\n//# sourceURL=http://h/m.js\n`);
  // A report-only policy refuses nothing.
  await r.ask(markWorker('http://h/m.js', 'm', t), answerOf(200, 'b()', { 'content-type': 'text/javascript', 'content-security-policy-report-only': "default-src 'none'" }));
  assert.deepEqual(late, ['http://h/m.js']);
  // A script keploy could not fetch: its seeding's load, as before, and no line.
  assert.equal((await r.ask(markWorker('http://h/m.js', 'm', t), new Error('net')))[1][1].body, workerAnswer(t, 5, 'm', 'http://h/m.js'));
  assert.deepEqual(late, ['http://h/m.js']);
  assert.match(lateLine('a test', 'http://h/m.js'), /^keploy: in a test, the module Web Worker at http:\/\/h\/m\.js is served with a Content-Security-Policy, .* runs after the modules the script imports: .*; if one does, serve the worker's script with no Content-Security-Policy where the tests run/);
});
