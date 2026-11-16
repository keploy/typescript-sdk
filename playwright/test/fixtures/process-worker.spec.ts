import fs from 'node:fs';
import { test as keployTest } from '../../dist';

// A worker fixture (not auto) that makes a test account from Math.random, as
// a suite makes one account for its worker's tests: the first test that asks
// for it sets it up. A second (team) that only the third test asks for. A
// test fixture (lead), an option and a plain value next to them. Each test
// makes its own data from Math.random after. USE_ACCOUNT=1 gives account's
// function through test.use instead, with no formatter in
// Error.prepareStackTrace and a stack trace limit of 0 while it registers.
// BROKEN=1 adds a test whose worker fixture fails before use().
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
const sms = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
const limit = Error.stackTraceLimit;
const test = keployTest.extend<{ lead: string; handlers: Array<() => string>; label: string }, { account: string; team: string; broken: string }>({
  account: [async ({}, use) => { await use(`acct-${Math.random()}`); }, { scope: 'worker' }],
  team: [async ({}, use) => { const t = `team-${Math.random()}`; await use(t); }, { scope: 'worker' }],
  broken: [async ({}, use) => { if (Math.random() < 2) throw new Error('no account today'); await use(''); }, { scope: 'worker' }],
  lead: async ({}, use) => { await use(`lead-${Math.random()}`); },
  handlers: [() => 'a', () => 'b'],
  label: ['x', { option: true }],
});
const after = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
const pst = { extend: { same: after?.value === sms?.value && after?.get === undefined, limit: Error.stackTraceLimit === limit } };
if (process.env.USE_ACCOUNT) {
  delete (Error as { prepareStackTrace?: unknown }).prepareStackTrace;
  Error.stackTraceLimit = 0;
  test.use({ account: async ({}, use) => { await use(`used-${Math.random()}`); } });
  Object.assign(pst, { use: { absent: Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace') === undefined, limit: Error.stackTraceLimit === 0 } });
  Error.stackTraceLimit = limit;
  if (sms) Object.defineProperty(Error, 'prepareStackTrace', sms);
}
test('first', ({ account, lead }) => {
  void account;
  keep('first', [lead, Math.random(), Math.random()]);
  keep('pst', pst);
});
test('second', ({ account }) => {
  void account;
  keep('second', [Math.random(), Math.random()]);
});
test('third', ({ account, team, handlers, label }) => {
  void account; void team;
  keep('third', [Math.random(), Math.random(), handlers[0](), label]);
});
if (process.env.BROKEN) {
  test.afterEach(({}, testInfo) => { if (testInfo.title === 'broken') keep('broken', [Math.random()]); });
  test('broken', ({ broken }) => { void broken; });
}
