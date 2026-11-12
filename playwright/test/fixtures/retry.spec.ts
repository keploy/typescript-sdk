import fs from 'node:fs';
import { test } from '../../dist';

test.describe('retried', () => {
  // A retry of this group's test, whatever the command line says.
  test.describe.configure({ retries: 1 });
  test('fails its first attempt', async ({}, testInfo) => {
    fs.writeFileSync(`${process.env.MARKER_DIR}/attempt-${testInfo.retry}`, '1');
    if (testInfo.retry === 0) throw new Error('the first attempt fails');
  });
});
