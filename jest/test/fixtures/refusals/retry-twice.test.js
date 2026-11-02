const log = require('./../log.cjs');
jest.retryTimes(2);
let n = 0;
test('flaky', () => {
  n += 1;
  log(`body flaky ${n}`);
  if (n === 1) throw new Error('first run fails');
});
