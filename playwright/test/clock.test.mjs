// Unit rows of the test process's held clock (src/clock.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ENV_HOLD_CLOCK, HELD_LINE, SEED_WITH_START_DIGITS, heldBeforeLine, holdingFromEnv, holds, seatClock, seedWithStart, startOf, unheldLine } from '../dist/clock.js';
import { seatRandom, setAside } from '../dist/random.js';

const require = createRequire(import.meta.url);
const R = 'a'.repeat(32);

test('KEPLOY_HOLD_CLOCK: unset says nothing, on holds, off does not, anything else is refused naming it', () => {
  for (const v of [undefined, '', '  ']) assert.deepEqual(holdingFromEnv({ [ENV_HOLD_CLOCK]: v }), { mode: 'unset' }, String(v));
  for (const v of ['on', 'ON', '1', 'true', ' true ']) assert.deepEqual(holdingFromEnv({ [ENV_HOLD_CLOCK]: v }), { mode: 'on' }, v);
  for (const v of ['off', 'OFF', '0', 'false']) assert.deepEqual(holdingFromEnv({ [ENV_HOLD_CLOCK]: v }), { mode: 'off' }, v);
  const r = holdingFromEnv({ [ENV_HOLD_CLOCK]: 'maybe' });
  assert.equal(r.mode, 'refused');
  assert.match(r.refusal, /^keploy: KEPLOY_HOLD_CLOCK="maybe" is neither on nor off/);
});

test('a test\'s clock is held only when asked: off never, else its option when set, else KEPLOY_HOLD_CLOCK=on', () => {
  const on = { mode: 'on' }, off = { mode: 'off' }, unset = { mode: 'unset' };
  assert.deepEqual([holds(unset, undefined), holds(unset, true), holds(unset, false)], [false, true, false]);
  assert.deepEqual([holds(on, undefined), holds(on, true), holds(on, false)], [true, true, false]);
  assert.deepEqual([holds(off, undefined), holds(off, true), holds(off, false)], [false, false, false]);
});

test('a held seed carries its test\'s start as its last 12 hex digits, and only a seed of that form carries one', () => {
  const start = Date.UTC(2026, 10, 4, 3, 4, 5, 678);
  const s = seedWithStart(R, start);
  assert.equal(s.length, SEED_WITH_START_DIGITS);
  assert.equal(s, R + start.toString(16).padStart(12, '0'));
  assert.equal(startOf(s), start);
  // No start: another length, a non-hex digit, a time out of range.
  assert.equal(startOf(R), null);
  assert.equal(startOf(''), null);
  assert.equal(startOf(s.slice(1)), null);
  assert.equal(startOf(`${s}0`), null);
  assert.equal(startOf(s.slice(0, -1) + 'g'), null);
  assert.equal(startOf(`g${s.slice(1)}`), null);
  assert.equal(startOf(R + 'f'.repeat(12)), null);
  assert.equal(startOf(R + '0'.repeat(12)), null);
  // The bounds: 2000-01-01 is a start, the millisecond before is not; 2200 is not.
  assert.equal(startOf(seedWithStart(R, Date.UTC(2000, 0, 1))), Date.UTC(2000, 0, 1));
  assert.equal(startOf(R + (Date.UTC(2000, 0, 1) - 1).toString(16).padStart(12, '0')), null);
  assert.equal(startOf(R + (Date.UTC(2200, 0, 1) - 1).toString(16).padStart(12, '0')), Date.UTC(2200, 0, 1) - 1);
  assert.equal(startOf(R + Date.UTC(2200, 0, 1).toString(16).padStart(12, '0')), null);
  // A random part of another length, or a start that is no time, is sent as it is.
  assert.equal(seedWithStart('abc', start), 'abc');
  assert.equal(seedWithStart(R, 5), R);
  assert.equal(seedWithStart(R, start + 0.5), R);
  assert.equal(seedWithStart(R, Date.UTC(2000, 0, 1) - 1), R);
  assert.equal(seedWithStart(R, Date.UTC(2200, 0, 1)), R);
});

test('the lines say what is held, how to keep the real clock, and why a test asked for is not held', () => {
  assert.match(HELD_LINE, /^keploy: each test's clock in the test process is held, as asked: /);
  assert.match(HELD_LINE, /set use: \{ keployHoldClock: false \} for it; KEPLOY_HOLD_CLOCK=off keeps every test's\.$/);
  const tail = 'so the test reads keploy\'s run clock, and a value it stamps with the time may differ from its recording\'s';
  assert.equal(unheldLine('g › t', 'unseeded'), 'keploy: the clock of g › t in the test process is not held, though asked: ' +
    `its random numbers are not seeded (KEPLOY_SEED_RANDOM=off, or keploySeedRandom: false), and the clock's start travels in the seed; ${tail}.`);
  assert.equal(unheldLine('g › t', 'no seed'), 'keploy: the clock of g › t in the test process is not held, though asked: ' +
    `keploy answered its begin with no seed, and the clock's start travels in the seed; ${tail}.`);
  assert.equal(unheldLine('g › t', 'no start'), 'keploy: the clock of g › t in the test process is not held, though asked: ' +
    `the seed keploy answered carries no clock start (its recording was made with the clock not held); ${tail}: record the test again with the clock held.`);
  assert.match(heldBeforeLine('g › t'), /^keploy: the recording of g › t held its clock in the test process \(its seed carries a start\), but this run does not hold it/);
});

test('seated: this file\'s reads read the held clock, one millisecond later at each; a Date is a Date; putting back gives the real one, but keeps a stub put there after', () => {
  const Real = Date;
  const start = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
  const unseat = seatClock(start);
  try {
    assert.notEqual(globalThis.Date, Real);
    assert.equal(Date.now(), start);
    assert.equal(new Date().getTime(), start + 1);
    assert.equal(Date(), new Real(start + 2).toString());
    // With an argument it is the real Date's.
    assert.equal(new Date(5).getTime(), 5);
    assert.equal(new Date('2020-01-01T00:00:00Z').getTime(), Real.UTC(2020, 0, 1));
    assert.equal(Date.UTC(2020, 0, 1), Real.UTC(2020, 0, 1));
    assert.equal(Date.parse('2020-01-01T00:00:00Z'), Real.UTC(2020, 0, 1));
    const d = new Date();
    assert.ok(d instanceof Date && d instanceof Real);
    assert.equal(Object.getPrototypeOf(d), Real.prototype);
    assert.equal(Date.prototype, Real.prototype);
    assert.equal(d.getTime(), start + 3);
    class Mine extends Date {}
    const m = new Mine();
    assert.ok(m instanceof Mine && m instanceof Real);
    assert.equal(m.getTime(), start + 4);
    // A read through a callback of a native function is the caller's.
    assert.deepEqual([0, 0].map(() => Date.now()), [start + 5, start + 6]);
  } finally { unseat(); }
  assert.equal(globalThis.Date, Real);
  assert.ok(Math.abs(Date.now() - Real.now()) < 1000);
  const again = seatClock(start);
  const stub = { now: () => 1 };
  globalThis.Date = stub;
  again();
  assert.equal(globalThis.Date, stub);
  globalThis.Date = Real;
});

test('seated: a read by Playwright\'s code, by Node\'s own, or while a worker fixture is set up reads the real clock and takes no held millisecond', async () => {
  const Real = Date;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kclk-'));
  const reads = {};
  for (const p of ['playwright', 'playwright-core', '@playwright/test']) {
    const lib = path.join(dir, 'node_modules', ...p.split('/'), 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'reads.js'), 'exports.now = () => Date.now(); exports.date = () => new Date().getTime(); exports.str = () => Date(); ' +
      // A builtin between (map calls Date.now) names no file: its caller reads.
      'exports.mapped = () => [0].map(Date.now)[0];\n');
    reads[p] = require(path.join(lib, 'reads.js'));
  }
  // A script with no absolute file (vm's, named relative) is no reader: its
  // caller is. Here Playwright's code calls it.
  const viaPlaywright = path.join(dir, 'node_modules', 'playwright-core', 'lib', 'vm.js');
  fs.writeFileSync(viaPlaywright, 'const vm = require("node:vm"); const f = vm.runInThisContext("(() => Date.now())", { filename: "probe.js" }); exports.now = () => f();\n');
  const vmRead = require(viaPlaywright);
  // A script Node names node: reads for itself (vm names one so here, as Node
  // names its own modules and the libraries it bundles).
  const nodeNamed = vm.runInThisContext('(() => Date.now())', { filename: 'node:probe' });
  // A file of this package's own (beside dist/clock.js) reads for itself.
  const ownFile = path.join(path.dirname(require.resolve('../dist/clock.js')), `own-read-probe-${process.pid}.js`);
  fs.writeFileSync(ownFile, 'exports.now = () => Date.now();\n');
  // A library of the suite's under node_modules (not Playwright's) is the test's.
  const libDir = path.join(dir, 'node_modules', 'playwright-helpers');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'index.js'), 'exports.now = () => Date.now();\n');
  const lib = require(libDir);
  const user = path.join(dir, 'helper.js');
  fs.writeFileSync(user, 'exports.now = () => Date.now();\n');
  const helper = require(user);
  const start = Date.UTC(2026, 0, 2);
  const unrandom = seatRandom(Math.random);
  const unseat = seatClock(start);
  try {
    const before = Date.parse(new Date(performance.timeOrigin + performance.now()).toISOString());
    assert.ok(Math.abs(vmRead.now() - before) < 1000, 'vm');
    assert.ok(Math.abs(require(ownFile).now() - before) < 1000, 'own');
    for (const [p, r] of Object.entries(reads)) {
      assert.ok(Math.abs(r.now() - before) < 1000, p);
      assert.ok(Math.abs(r.date() - before) < 1000, p);
      assert.notEqual(r.str(), new Date(start).toString(), p);
      assert.ok(Math.abs(r.mapped() - before) < 1000, p);
    }
    assert.ok(Math.abs(nodeNamed() - before) < 1000, 'node:');
    // Node's own code (http's Date header) reads the real clock.
    const srv = http.createServer((_q, res) => res.end('x'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const date = await new Promise((r, e) => http.get(`http://127.0.0.1:${srv.address().port}/`, (res) => { res.resume(); r(res.headers.date); }).on('error', e));
    srv.close();
    assert.ok(Math.abs(Real.parse(date) - before) < 5000, date);
    assert.equal(helper.now(), start);
    assert.equal(lib.now(), start + 1);
    // The test's own read through a builtin is the test's.
    assert.equal([0].map(Date.now)[0], start + 2);
    // While a worker fixture is set up (setAside holds), reads are the worker's.
    const back = setAside();
    const w = Date.now();
    back();
    assert.ok(Math.abs(w - before) < 1000, String(w));
    assert.equal(Date.now(), start + 3);
  } finally { unseat(); unrandom(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ownFile, { force: true }); }
});
