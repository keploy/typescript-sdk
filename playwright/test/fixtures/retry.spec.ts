import fs from 'node:fs';
import { test } from '../../dist';

// DRAWS_BASE serves /draws (see seeded.spec.ts). The test's first attempt
// fails after its page drew; run with --retries=1, its retry draws again.
test('flips', async ({ page }, testInfo) => {
  await page.goto(`${process.env.DRAWS_BASE ?? ''}/draws`);
  const drew = await page.evaluate(() => (window as unknown as { __draws: unknown }).__draws);
  fs.writeFileSync(`${process.env.MARKER_DIR}/flips-${testInfo.retry}.json`, JSON.stringify(drew));
  if (testInfo.retry === 0) throw new Error('the first attempt fails');
});
