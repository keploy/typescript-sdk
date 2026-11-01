import { test, given } from '../../dist';

test.beforeAll(async () => {
  await given('early', 'early-value-1');
});
test('after a given outside', async () => {});
