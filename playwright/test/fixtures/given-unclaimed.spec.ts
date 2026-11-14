import { test } from '@playwright/test';
import { given } from '../../dist';

// @playwright/test's own test: no worker of @keploy/playwright's test claims
// the run, so a value given here has no test and no worker to go to.
test.beforeAll(async () => {
  await given('early', 'early-value-1');
});
test('after a given with no worker', async () => {});
