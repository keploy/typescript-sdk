import { given, test } from '../../dist';

// After given-files-a's setup value: two values this file's setup gives at once.
test.beforeAll(async () => {
  await Promise.all([given('one', 'one-t'), given('two', 'two-t')]);
});
test('t1', async () => {});
