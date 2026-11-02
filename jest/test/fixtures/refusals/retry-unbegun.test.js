const log = require('./../log.cjs');
jest.retryTimes(1);
beforeEach(() => log('beforeEach steady'));
test('steady', () => log('body steady'));
