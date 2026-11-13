import fs from 'node:fs';
import { test } from '../../dist';

// A suite that makes its test data in the test process, as many do: a name
// stamped with Math.random(), drawn in the Node worker that runs the test,
// not in its browser. Each test keeps what it drew in its beforeEach, its
// body and its afterEach; no test opens a page.
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/${name}.json`, JSON.stringify(v));
// The worker's own Math.random, as this file loads, before any test.
const own = Math.random;
const drew = new Map<string, number[]>();
const draw = (): void => {
  const t = test.info().title;
  drew.set(t, [...(drew.get(t) ?? []), Math.random()]);
};

test.beforeEach(() => draw());
test.afterEach(() => {
  draw();
  keep(test.info().title, drew.get(test.info().title));
});

test('made', () => { draw(); draw(); });
test('other', () => { draw(); draw(); });
test.describe('own', () => {
  test.use({ keploySeedRandom: false });
  test('mine', () => { draw(); draw(); });
});
// Outside every test the worker draws its own numbers again.
test.afterAll(() => keep('outside', { own: Math.random === own, draws: [Math.random(), Math.random()] }));
