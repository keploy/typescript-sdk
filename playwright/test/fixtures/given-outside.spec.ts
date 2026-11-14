import { expect, given, test } from '../../dist';

// Names a test file's setup mints once for the tests that follow it: given
// outside every test, once the worker claimed the run, each is the worker's.
test.describe('w', () => {
  test.beforeAll(async () => {
    expect(await given('early', 'early-value-1')).toBe('early-value-1');
  });
  test('first', async () => {});
  test('second', async () => {});
});

// A second setup, after the tests above ended: outside every test too.
test.describe('later', () => {
  test.beforeAll(async () => {
    await given('late', 'late-value-1');
  });
  test('third', async () => {});
});

test.describe('last', () => {
  test.beforeAll(async () => {
    await given('over', 'over-value-1');
  });
  test('fourth', async () => {});
});
