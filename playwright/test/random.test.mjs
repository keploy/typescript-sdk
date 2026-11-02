// Unit rows of the seeding: the env rule, the seed, the test process's
// stream, and the browser's init script run in a Node vm context in place of
// a page. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_KEY, ENV_SEED_RANDOM, LOADS_KEY, OFF_LINE, PAGE_KEY, SEEDED_LINE, freshSeed, initScript, pageScript, processRandom, seatRandom, seedingFromEnv, unplacedLine, unseededLine } from '../dist/random.js';
import { SEED } from '../dist/agent.js';
import { documentAt } from './draws.mjs';

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
    'the test process keeps its own crypto, and its own Math.random outside every test (beforeAll, afterAll, a worker fixture, a file as it loads). ' +
    'To turn it off, record and replay with KEPLOY_SEED_RANDOM=off, or set use: { keploySeedRandom: false } in the Playwright config.');
  assert.equal(OFF_LINE, 'keploy: random numbers are not seeded (KEPLOY_SEED_RANDOM=off, or keploySeedRandom: false), ' +
    'so the test process and the test browser draw their own each run: data a test makes from them (a name, an email, an ID) differs from its recording\'s ' +
    'while a mocked dependency answers with the recording\'s, so a test that checks one against the other fails or is set aside, ' +
    'and a page script\'s random choice may make calls the recording never saw. ' +
    'Unset KEPLOY_SEED_RANDOM and keploySeedRandom to seed them per test.');
  assert.equal(unseededLine('g › t'), 'keploy: keploy answered the begin of g › t with no seed, so its browser and its test process draw their own random numbers: ' +
    'its recording kept none (it was recorded before keploy kept seeds, or with seeding off: record the test again with seeding on, the default, to seed it), ' +
    'or the test was pulled from a Keploy branch, which keeps no seed yet, or this keploy predates seeds.');
  assert.equal(unplacedLine('g › t', 'http://h/p'), 'keploy: in g › t, the document at http://h/p drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is in a page the app opened that keploy cannot place in the test\'s order (a popup opened with noopener, as a link with target=_blank opens one, ' +
    'or at another origin than its opener\'s page, or after that page moved on; or a frame of another origin in one).');
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

test('without session storage, or with an unreadable count, a document still draws seeded numbers', () => {
  const s = initScript(S1);
  assert.deepEqual(documentAt(s, '/p', null).draws(), documentAt(s, '/p').draws());
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
