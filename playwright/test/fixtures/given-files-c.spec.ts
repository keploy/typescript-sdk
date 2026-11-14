import { given, test } from '../../dist';

// The same name a's setup gave.
test.beforeAll(async () => {
  await given('run', 'run-c');
});
test('c1', async () => {});
