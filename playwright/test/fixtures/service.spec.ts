import { test } from '../../dist';
import { serviceRun } from './service-helper';

// The page at /sw with its Service Worker (service-helper.ts).
test('service worker', async ({ page }) => {
  await serviceRun(page);
});
