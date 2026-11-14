import { given, test } from '../../dist';

// Three files one worker runs one after another: a and c give one name in their setup, b in a test.
test.beforeAll(async () => {
  await given('run', 'run-a');
});
test('a1', async () => {});
test('a2', async () => {});
