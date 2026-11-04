import fs from 'node:fs';
import { test as keployTest, expect } from '../../dist';
import { uniqueSuffix } from './clock-helper';

// A suite that stamps its test data with the time in the test process: each
// test keeps what its code read from the clock (Date.now(), new Date(),
// Date()) in its beforeEach, its body (through a helper file) and its
// afterEach. Whether a test's clock is held is the run's to say
// (KEPLOY_HOLD_CLOCK) and the groups' (keployHoldClock).
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/clock-${name}.json`, JSON.stringify(v));
const RealDate = Date;
const realNow = Date.now;
const read = new Map<string, unknown[]>();
const add = (v: unknown): void => {
  const t = test.info().title;
  read.set(t, [...(read.get(t) ?? []), v]);
};

// A worker fixture that stamps a test account with the time while it is set
// up, in the first test that asks for it: the worker's read, not the test's.
const test = keployTest.extend<{}, { account: string }>({
  account: [async ({}, use) => { await use(`acct-${Date.now()}`); }, { scope: 'worker' }],
});

test.beforeEach(() => add(Date.now()));
test.afterEach(() => {
  add(new Date().getTime());
  keep(test.info().title, read.get(test.info().title));
});

test('stamps', async ({ account }) => {
  add(uniqueSuffix());
  // Playwright's own code between two reads (a step, whose begin the worker
  // stamps with Date.now(), and an expect) reads the real clock and takes no
  // held millisecond.
  await test.step('a step', async () => { expect(1).toBe(1); });
  add(uniqueSuffix());
  // A Date is a Date, held or not; with an argument it is the real one's.
  const d = new Date();
  add([d instanceof Date, d instanceof RealDate, Object.getPrototypeOf(d) === RealDate.prototype, Date.UTC(2020, 0, 1), new Date(0).getTime()]);
  add(Date());
  // Playwright's waits keep running: a poll that never passes, every 100 ms,
  // gives up before its 300 ms deadline would pass, after its third call
  // (about 200 ms of the real clock in), and a timer waits its 20 ms.
  const t0 = realNow();
  await new Promise((r) => setTimeout(r, 20));
  let timedOut = false;
  try { await expect.poll(() => false, { timeout: 300, intervals: [100] }).toBe(true); } catch { timedOut = true; }
  add([timedOut, realNow() - t0 >= 150]);
  // The account was stamped from the real clock.
  add(Math.abs(Number(account.slice(5)) - realNow()) < 600000);
});
test('other', () => { add(uniqueSuffix()); });
test.describe('own', () => {
  test.use({ keployHoldClock: false });
  test('free', () => { add(Date.now()); });
});
test.describe('asked', () => {
  test.use({ keployHoldClock: true });
  test('held', () => { add(Date.now()); });
});
// Outside every test the clock is the real one again.
test.afterAll(() => keep('outside', { real: Date === RealDate, now: Date.now() }));
