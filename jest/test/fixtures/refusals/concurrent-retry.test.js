const log = require('./../log.cjs');
jest.retryTimes(1);
test.concurrent('at once', async () => log('body at once'));
