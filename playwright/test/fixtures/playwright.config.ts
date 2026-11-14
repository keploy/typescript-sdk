import { defineConfig } from '@playwright/test';

// The rows' Playwright project: one worker, no retries, as keploy runs a suite.
export default defineConfig({
  testDir: '.',
  workers: 1,
  retries: 0,
  timeout: Number(process.env.PW_TIMEOUT || 30000),
  reporter: [['json'], ['./steps-reporter.cjs']],
  outputDir: process.env.PW_OUTPUT_DIR || 'test-results',
  // PW_UNNAMED=1: one unnamed project, Playwright's default when a config
  // lists none. PW_BROWSER=firefox or webkit runs the rows in that browser
  // (Chromium, Playwright's default, otherwise).
  projects: [{
    name: process.env.PW_UNNAMED ? '' : 'p1',
    use: { headless: true, browserName: (process.env.PW_BROWSER || 'chromium') as 'chromium' | 'firefox' | 'webkit' },
  }],
});
