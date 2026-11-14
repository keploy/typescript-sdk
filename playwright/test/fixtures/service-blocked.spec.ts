import { test } from '../../dist';
import { serviceRun } from './service-helper';

// The page at /sw (service-helper.ts), with Playwright blocking every
// Service Worker.
test.use({ serviceWorkers: 'block' });

test('service worker blocked', async ({ page }) => {
  await serviceRun(page);
});
