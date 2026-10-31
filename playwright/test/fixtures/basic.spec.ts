import fs from 'node:fs';
import { test, expect, given } from '../../dist';

test.describe('g', () => {
  // A given needs an open test: the begin comes before beforeEach.
  test.beforeEach(async () => {
    expect(await given('seed', 'seed-value-1')).toBe('seed-value-1');
  });
  test('a', async () => {
    const joined = (process.env.KEPLOY_MOCK_AGENT ?? 'off') !== 'off';
    expect(process.env.KEPLOY_TEST_PID).toBe(joined ? String(process.pid) : undefined);
    if (process.env.MARKER_DIR) fs.writeFileSync(`${process.env.MARKER_DIR}/a`, String(process.pid));
  });
  test('b', async () => {
    expect(1).toBe(2);
  });
  test('c', async () => {
    test.skip(true, 'its own skip');
  });
  test('d', async () => {
    test.fail();
    expect(1).toBe(2);
  });
});
