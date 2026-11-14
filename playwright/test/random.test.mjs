// Unit rows of the seeding: the env rule, the seed, the test process's
// stream, and the browser's init script run in a Node vm context in place of
// a page. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_KEY, ENV_SEED_RANDOM, FAKER, LOADS_KEY, OFF_LINE, PAGE_KEY, SEEDED_LINE, esmFile, exportOf, fakerLine, fakersIn, fakersOf, firstScript, freshSeed, initScript, besideOf, othersNow, pageAddress, pageScript, placePages, processRandom, seatFaker, seatRandom, seedFaker, seedingFromEnv, setAside, unplacedLine, unseededLine, WORKER_PARAM, markWorker, workerMark, workerScript, workerRoutes, workerAnswer, cspAllowsData } from '../dist/random.js';
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
    'Service Workers keep the browser\'s own, and so do a page the app opens and a worker that keploy cannot place or reach (each one is named); ' +
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
    for (const [kind, n] of [['w', -1], ['m', -1], ['s', -1], ['x', -1], ['p', 0], ['p', 7]]) {
      const m = markWorker(url, kind, t, n);
      assert.ok(new URL(m).searchParams.has(WORKER_PARAM), m);
      assert.deepEqual(workerMark(m), { kind, token: t, n, url }, m);
    }
  }
  assert.equal(markWorker('http://h/w.js?a=1#f', 'w', t), `http://h/w.js?a=1&__keploy_worker=w.${t}#f`);
  for (const u of ['http://h/w.js', `http://h/w.js?__keploy_worker=w.${t}&a=1`, `http://h/w.js?__keploy_worker=z.${t}`, `http://h/w.js?__keploy_worker=w.${t.toUpperCase()}`,
    `http://h/w.js?__keploy_worker=w.${t}.0`, `http://h/w.js?__keploy_worker=o.${t}`, `http://h/w.js?__keploy_worker=o.${t}.0`, `http://h/w.js?__keploy_worker=p.${t}`, `http://h/w.js?__keploy_worker=w.${t.slice(1)}`]) {
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

test('the lines for a worker keploy cannot reach say what it is, why, and the next step', () => {
  assert.equal(unplacedLine('t', 'blob:', 'worker'), 'keploy: in t, the worker at blob: draws the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is a worker started from a script keploy cannot mark (a blob: or data: URL, or a URL the browser refused with keploy\'s mark, as a Trusted Types policy may), ' +
    'so keploy cannot put its seeding ahead of the script; start it from the script\'s http(s) URL to seed it.');
  assert.equal(unplacedLine('t', 'http://h/s.js', 'shared'), 'keploy: in t, the Shared Worker at http://h/s.js draws the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is a Shared Worker, and Firefox does not let keploy reach a Shared Worker\'s script to put its seeding ahead of it; ' +
    'record and replay the test in Chromium or WebKit to seed it.');
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

// A context whose route keeps its matcher and handler, and a route of it
// that records what the handler did.
function routed() {
  const r = {};
  const context = { route: async (match, handler) => { r.match = match; r.handler = handler; } };
  r.ask = async (url, answer) => {
    const did = [];
    const route = {
      request: () => ({ url: () => url }),
      fetch: async (o) => { did.push(['fetch', o.url]); if (answer instanceof Error) throw answer; return answer; },
      fulfill: async (o) => { did.push(['fulfill', { ...o, body: String(o.body) }]); },
      continue: async (o) => { did.push(['continue', o.url]); },
      fallback: async () => { did.push(['fallback']); },
    };
    await r.handler(route);
    return did;
  };
  return { r, context };
}
const answerOf = (status, body, headers = { 'content-type': 'text/javascript', 'content-encoding': 'gzip', 'content-length': '3', 'x-a': '1' }) =>
  ({ ok: () => status >= 200 && status < 300, status: () => status, headers: () => headers, body: async () => Buffer.from(body) });

test('workerRoutes answers a marked classic worker script with its seeding then importScripts of the app\'s own at its URL with no mark, under the status and headers the app\'s server gave it; each start of a token is the next instance', async () => {
  const { r, context } = routed();
  await workerRoutes(context);
  const t = '01'.repeat(16);
  assert.equal(r.match(new URL(markWorker('http://h/w.js', 'w', t))), true);
  assert.equal(r.match(new URL('http://h/w.js?a=1')), false);
  const headers = { 'content-type': 'text/javascript', 'x-a': '1' };
  assert.deepEqual(await r.ask(markWorker('http://h/w.js?a=1#f', 'w', t), answerOf(201, 'app()')), [['fetch', 'http://h/w.js?a=1#f'],
    ['fulfill', { status: 201, headers, body: `${workerScript(t, 0, 'w')}importScripts("http://h/w.js?a=1#f");\n` }]]);
  const second = await r.ask(markWorker('http://h/w.js?a=1', 'w', t), answerOf(200, 'app()'));
  assert.equal(second[1][1].body, workerAnswer(t, 1, 'w', 'http://h/w.js?a=1'));
  assert.equal(workerAnswer(t, 1, 'w', 'http://h/w.js?a=1'), `${workerScript(t, 1, 'w')}importScripts("http://h/w.js?a=1");\n`);
});

test('workerRoutes answers a module worker script with an import of its seeding then one of the app\'s own; its seeding is workerScript; an answer not ok goes as given; one it cannot fetch gets its seeding with no header of the app\'s; a malformed mark falls back', async () => {
  const { r, context } = routed();
  const answered = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()) });
  const t = '23'.repeat(16);
  const did = await r.ask(markWorker('http://h/m.js', 'm', t), answerOf(200, 'export {}'));
  assert.equal(did[1][1].body, `import ${JSON.stringify(markWorker('http://h/m.js', 'p', t, 0))};\nimport "http://h/m.js";\n`);
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

test('cspAllowsData: no policy, or each policy whose script or worker source list is named lists data:; a policy that names one without it refuses', () => {
  const csp = (v) => ({ 'content-security-policy': v });
  assert.equal(cspAllowsData({}), true);
  for (const v of ["img-src 'self'", "script-src 'self' data:", "default-src 'self' DATA:", "script-src data:; worker-src data:", "script-src-elem data:; worker-src 'self' data:"]) assert.equal(cspAllowsData(csp(v)), true, v);
  for (const v of ["script-src 'self'", "default-src 'self'", "script-src data:; worker-src 'self'", "script-src-elem 'self'; script-src data:", "child-src 'self'; script-src data:",
    "script-src data:, default-src 'self'", "script-src data:\nscript-src 'none'", "script-src 'none'; script-src data:", "SCRIPT-SRC 'self'",
    "script-src data:; Worker-Src 'self'"]) assert.equal(cspAllowsData(csp(v)), false, v);
});

test('workerAnswer: a classic Shared Worker runs its seeding, then imports the app\'s script at its URL; its location shows no mark; a module one imports its seeding as a data: module, then the app\'s script', () => {
  const t = '45'.repeat(16);
  const href = markWorker('http://h/s.js?q=1', 's', t);
  const imported = [];
  const w = workerAt(href, workerAnswer(t, 2, 's', 'http://h/s.js?q=1'), { importScripts: (...u) => { imported.push(u); } });
  assert.deepEqual(imported, [['http://h/s.js?q=1']]);
  assert.deepEqual(w.draws(), workerAt(href, workerScript(t, 2, 's')).draws());
  assert.equal(w.run('location.href'), 'http://h/s.js?q=1');
  const m = workerAnswer(t, 2, 'x', 'http://h/m.js?q=1');
  const data = /^import "data:text\/javascript;base64,([A-Za-z0-9+/=]+)";\nimport "http:\/\/h\/m\.js\?q=1";\n$/.exec(m);
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
  const w = workerAt(href, '', {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    MessageEvent, load,
  });
  const done = w.run(`(async () => { ${body.replace('await import(', 'await load(')} })()`);
  return { w, events, done };
}

test('workerAnswer: a module Shared Worker whose policy refuses data: runs its seeding in its answer, then imports the app\'s script; each connect event before that script has run is held and given after, in order, with its ports; one after goes to the app\'s handler as it comes', async () => {
  const t = '89'.repeat(16);
  let loaded;
  const got = [];
  const { w, events, done } = heldWorker(t, () => new Promise((resolve) => { loaded = resolve; }));
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
  assert.equal(got.length, 2);
  assert.ok(got[0] === a.port1 && got[1] === b.port1);
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

test('workerRoutes answers a Shared Worker\'s script with workerAnswer, a module one whose policy refuses data: with its seeding in the answer; each request it fulfills is answered', async () => {
  const { r, context } = routed();
  const answered = [];
  await workerRoutes(context, { answered: (q) => answered.push(q.url()) });
  const t = '67'.repeat(16);
  const headers = { 'content-type': 'text/javascript', 'x-a': '1' };
  const s0 = markWorker('http://h/s.js', 's', t);
  assert.deepEqual(await r.ask(s0, answerOf(200, '﻿app()')), [['fetch', 'http://h/s.js'], ['fulfill', { status: 200, headers, body: workerAnswer(t, 0, 's', 'http://h/s.js') }]]);
  assert.equal((await r.ask(s0, answerOf(200, 'app()')))[1][1].body, workerAnswer(t, 1, 's', 'http://h/s.js'));
  const x0 = markWorker('http://h/m.js', 'x', t.replace('6', '8'));
  assert.equal((await r.ask(x0, answerOf(200, 'export {}')))[1][1].body, workerAnswer(t.replace('6', '8'), 0, 'x', 'http://h/m.js', true));
  const policy = { 'content-type': 'text/javascript', 'content-security-policy': "script-src 'self'" };
  const x1 = markWorker('http://h/c.js', 'x', t.replace('6', '9'));
  assert.deepEqual(await r.ask(x1, answerOf(200, '﻿export {}', policy)), [['fetch', 'http://h/c.js'], ['fulfill', { status: 200, headers: policy, body: workerAnswer(t.replace('6', '9'), 0, 'x', 'http://h/c.js', false) }]]);
  assert.notEqual(workerAnswer(t, 0, 'x', 'http://h/c.js', false), workerAnswer(t, 0, 'x', 'http://h/c.js', true));
  // A classic one is not refused by a policy: it imports the app's script.
  const d0 = markWorker('http://h/d.js', 's', t.replace('6', 'a'));
  assert.equal((await r.ask(d0, answerOf(200, 'app()', policy)))[1][1].body, workerAnswer(t.replace('6', 'a'), 0, 's', 'http://h/d.js'));
  assert.deepEqual(answered, [s0, s0, x0, x1, d0]);
  // Not answered: what falls back.
  await r.ask(`http://h/m.js?__keploy_worker=s.${t}.3`);
  assert.equal(answered.length, 5);
});
