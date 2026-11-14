import { test, given } from '../../dist';

test('caller with spaces', async () => {
  await given('customer', 'customer-1');
});
