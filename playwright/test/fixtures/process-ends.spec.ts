import fs from 'node:fs';
import { test } from '../../dist';

// A test that throws and one that times out; each fails, so Playwright runs
// each in a worker of its own, and each worker's afterAll says whether its
// own Math.random is back.
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
const own = Math.random;
let last = '';
test('throws', () => { last = 'throws'; Math.random(); throw new Error('boom'); });
test('times out', async () => { last = 'times out'; test.setTimeout(1000); Math.random(); await new Promise(() => {}); });
test.afterAll(() => keep(`after ${last}`, { own: Math.random === own }));
