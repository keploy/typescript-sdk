import { test as base, mergeTests } from '@playwright/test';
import { test as keploy } from '../../dist';

// A context that already holds a page when keploy's context fixture gets it:
// a fixture of the suite's, merged under keploy's, opens it. The test drives
// that page and opens none, so only the page already there tells keploy's
// fixture that the test's browser drew.
const held = base.extend({
  context: async ({ context }, use) => {
    await context.newPage();
    await use(context);
  },
});
const test = mergeTests(held, keploy);

test('held page', async ({ context }) => {
  await context.pages()[0].goto(`${process.env.DRAWS_BASE ?? ''}/draws`);
});

// A test that takes the context and opens no page: its browser drew nothing.
keploy('no page', async ({ context }) => {
  await context.cookies();
});
