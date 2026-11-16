import { test } from '../../dist';

// A suite's helper in a file of its own, as a login or a page object is:
// the first time a test's stack reaches this file, Playwright parses its
// source map. HELPER=step calls test.step, whose location Playwright reads
// from a stack; HELPER=stack reads an Error's stack, as a logger does.
export async function login(): Promise<void> {
  if (process.env.HELPER === 'stack') {
    void new Error('where').stack;
    return;
  }
  await test.step('login', async () => {});
}
