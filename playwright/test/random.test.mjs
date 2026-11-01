// Unit rows of the test browser's seeding: the env rule, the seed, and the
// init script run in a Node vm context in place of a page. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENV_SEED_RANDOM, LOADS_KEY, SEEDED_LINE, initScript, seedOf, seedingFromEnv, testID } from '../dist/random.js';
import { documentAt } from './draws.mjs';

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
    assert.equal(s.refusal, `keploy: KEPLOY_SEED_RANDOM=${JSON.stringify(v)} is neither on nor off; set it to off to give the test browser its own random numbers, or unset it to seed them per test`);
  }
});

test('the line says what is seeded, what is not, and both ways to turn it off', () => {
  assert.equal(SEEDED_LINE, 'keploy: the test browser\'s random numbers (Math.random, crypto.getRandomValues, crypto.randomUUID) are seeded per test, ' +
    'so a replay draws the numbers its recording drew; Web Workers and Service Workers keep the browser\'s own. ' +
    'To turn it off, record and replay with KEPLOY_SEED_RANDOM=off, or set use: { keploySeedRandom: false } in the Playwright config.');
});

test('a test\'s seed is a function of its keploy ID: the same for the same test, another for another', () => {
  assert.equal(testID({ project: 'p1', file: 'a/b.spec.ts', name: 'g › t' }), 'p1::a/b.spec.ts::g › t');
  assert.equal(testID({ file: 'a/b.spec.ts', name: 't' }), 'a/b.spec.ts::t');
  const s = seedOf('p1::a.spec.ts::t');
  assert.match(s, /^[0-9a-f]{32}$/);
  assert.equal(seedOf('p1::a.spec.ts::t'), s);
  for (const other of ['p1::a.spec.ts::u', 'p2::a.spec.ts::t', 'a.spec.ts::t', 'p1::b.spec.ts::t']) assert.notEqual(seedOf(other), s, other);
});

test('a seeded document draws the same numbers for the same seed and path, others for another seed or path', () => {
  const s1 = initScript(seedOf('t1'));
  const a = documentAt(s1, '/p').draws();
  assert.deepEqual(documentAt(s1, '/p').draws(), a);
  assert.notDeepEqual(documentAt(initScript(seedOf('t2')), '/p').draws(), a);
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

test('a document loaded again in the same tab draws new numbers, the same ones each run', () => {
  const s = initScript(seedOf('t'));
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
  const s = initScript(seedOf('t'));
  assert.deepEqual(documentAt(s, '/p', null).draws(), documentAt(s, '/p').draws());
  for (const junk of ['not json', '[1,2]', 'null', '{"/p":"x"}']) {
    assert.deepEqual(documentAt(s, '/p', new Map([[LOADS_KEY, junk]])).draws(), documentAt(s, '/p').draws(), junk);
  }
});

test('each function has its own stream: extra draws of one do not move another\'s', () => {
  const s = initScript(seedOf('t'));
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
  const d = documentAt(initScript(seedOf('t')));
  assert.equal(d.run('(() => { const a = new Uint32Array(5); return crypto.getRandomValues(a) === a && a.some((x) => x !== 0); })()'), true);
  // A view into the middle of a buffer is filled there only.
  assert.equal(d.run('(() => { const b = new Uint8Array(12); crypto.getRandomValues(new Uint8Array(b.buffer, 4, 4)); return b.slice(0, 4).every((x) => x === 0) && b.slice(8).every((x) => x === 0); })()'), true);
  assert.throws(() => d.run('crypto.getRandomValues(new Float32Array(2))'));
  assert.throws(() => d.run('crypto.getRandomValues(new Uint8Array(65537))'));
  // The functions keep their names and lengths, and stay on the prototype.
  assert.deepEqual(JSON.parse(d.run('JSON.stringify([Math.random.name, Math.random.length, crypto.getRandomValues.name, crypto.getRandomValues.length, crypto.randomUUID.name, Object.keys(crypto).length])')),
    ['random', 0, 'getRandomValues', 1, 'randomUUID', 0]);
});

test('a document without crypto.randomUUID (not a secure context) is not given one', () => {
  class Crypto { getRandomValues(a) { return a; } }
  const d = documentAt('');
  d.ctx.Crypto = Crypto;
  d.ctx.crypto = new Crypto();
  d.run(initScript(seedOf('t')));
  assert.equal(d.run('typeof crypto.randomUUID'), 'undefined');
  assert.equal(d.run('typeof Math.random()'), 'number');
});
