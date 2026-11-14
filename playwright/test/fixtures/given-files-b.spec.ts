import { given, test } from '../../dist';

// No setup: the test gives its own value.
test('b1', async () => {
  await given('own', 'own-b');
});
