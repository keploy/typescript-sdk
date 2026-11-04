import { defineConfig } from '@playwright/test';
import type { KeployOptions } from '../../dist';

// The rows' Playwright project: one worker, no retries, as keploy runs a suite.
export default defineConfig<KeployOptions>({
  testDir: '.',
  workers: 1,
  retries: 0,
  timeout: Number(process.env.PW_TIMEOUT || 30000),
  reporter: [['json'], ['./steps-reporter.cjs']],
  outputDir: process.env.PW_OUTPUT_DIR || 'test-results',
  // PW_UNNAMED=1: one unnamed project, Playwright's default when a config
  // lists none. PW_NOSEED=1: the project turns seeding off. PW_BROWSER: the
  // engine (chromium, the default, firefox or webkit).
  projects: [{
    name: process.env.PW_UNNAMED ? '' : 'p1',
    use: {
      headless: true,
      ...(process.env.PW_BROWSER ? { browserName: process.env.PW_BROWSER as 'chromium' | 'firefox' | 'webkit' } : {}),
      ...(process.env.PW_NOSEED ? { keploySeedRandom: false } : {}),
    },
  }],
});
