const log = require('./../log.cjs');
test.concurrent('at once', async () => log('body at once'));
describe('group', () => {
  test.concurrent('nested at once', async () => log('body nested at once'));
});
test('serial', () => log('body serial'));
