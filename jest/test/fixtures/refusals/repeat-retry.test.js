const log = require('./../log.cjs');
jest.retryTimes(1);
test('same', () => log('body same 1'));
test('same', () => log('body same 2'));
