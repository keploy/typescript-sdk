// Unit rows of the seeding: the env rule, the seed, the test process's
// stream, and the browser's init script run in a Node vm context in place of
// a page. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_KEY, ENV_SEED_RANDOM, LOADS_KEY, OFF_LINE, PAGE_KEY, SEEDED_LINE, firstScript, freshSeed, initScript, besideOf, othersNow, pageAddress, pageScript, placePages, processRandom, seatRandom, seedingFromEnv, setAside, unplacedLine, unseededLine } from '../dist/random.js';
import { SEED } from '../dist/agent.js';
import { OTHER, documentAt } from './draws.mjs';

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
    'in the test browser Math.random, crypto.getRandomValues and crypto.randomUUID, and in the test process Math.random, from the test\'s begin to its end ' +
    '(its beforeEach and afterEach hooks too). ' +
    'Web Workers and Service Workers keep the browser\'s own, and so does a page the app opens that keploy cannot place (each one is named); ' +
    'the test process keeps its own crypto, and its own Math.random outside every test (beforeAll, afterAll, a file as it loads) ' +
    'and while a worker fixture registered with this package\'s test.extend or test.use is set up. ' +
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
    try { E.prepareStackTrace = fmt; } finally { unseat3(); }
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
  for (const junk of ['not json', '[1,2]', 'null', '{"/p":"x"}']) {
    assert.deepEqual(documentAt(s, '/p', new Map([[LOADS_KEY, junk]])).draws(), documentAt(s, '/p').draws(), junk);
  }
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
