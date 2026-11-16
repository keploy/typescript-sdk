import fs from 'node:fs';
import { test } from '../../dist';
import { login } from './process-helper';

// Each test logs in through a helper in another file, then makes its data
// from Math.random. FAIL_FIRST=1 makes the first test fail, so Playwright
// runs the rest in a new worker.
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
test.beforeEach(async () => { await login(); });
for (const n of ['first', 'second', 'third']) {
  test(n, () => {
    if (process.env.FAIL_FIRST && n === 'first') throw new Error('the first test fails in this run');
    keep(n, [Math.random(), Math.random()]);
  });
}
