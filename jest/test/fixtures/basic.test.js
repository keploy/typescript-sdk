const log = require('./log.cjs');
const name = () => expect.getState().currentTestName;

describe('orders', () => {
  beforeEach(() => log(`beforeEach ${name()}`));
  afterEach(() => log(`afterEach ${name()}`));
  test('pays', () => log('body pays'));
  test('declines', () => {
    log('body declines');
    if (process.env.KJ_FAIL) throw new Error('declined for real');
  });
  test.skip('skipped by jest', () => log('body skipped by jest'));
  test.todo('later');
});

test('top', () => log('body top'));
