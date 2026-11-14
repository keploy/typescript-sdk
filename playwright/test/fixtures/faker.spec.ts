import fs from 'node:fs';
import { Faker, de, faker, fakerDE, fakerFR } from '@faker-js/faker';
import { seedFaker, test } from '../../dist';

// A suite that makes its test data with faker in the test process, as many
// do: an ID and a name, from faker's default instance and a locale's. Each
// test keeps what it made in its beforeEach, its body and its afterEach; no
// test opens a page. Playwright runs this file as CommonJS, so it gets faker
// 10, an ES module, through require.
const keep = (name: string, v: unknown): void => fs.writeFileSync(`${process.env.MARKER_DIR}/faker-${name}.json`, JSON.stringify(v));
// faker's own draw, as this file loads, before any test.
const own = faker.fakerCore.randomizer.next;
const made = new Map<string, unknown[]>();
const make = (): void => {
  const t = test.info().title;
  made.set(t, [...(made.get(t) ?? []), faker.string.uuid(), fakerDE.person.firstName()]);
};

test.beforeEach(() => make());
test.afterEach(() => {
  make();
  keep(test.info().title, made.get(test.info().title));
});

// The suite's own instances, made as this file loads: one given to
// seedFaker draws from the test's seed, one not given draws its own. One
// made in a test seeds itself from the test's Math.random.
const mine = seedFaker(new Faker({ locale: [de] }), 'mine');
const notGiven = new Faker({ locale: [de] });
test('own instances', () => {
  const inTest = new Faker({ locale: [de] });
  keep('own', { mine: [mine.string.uuid(), mine.person.firstName()], notGiven: notGiven.string.uuid(), inTest: inTest.string.uuid() });
});

test('made', () => { make(); });
test('other', () => { make(); });
// A test that seeds an instance itself draws it as it seeded it (an
// instance no other test draws: the seed stays with it after the test, as
// it would without keploy).
test('seeds itself', () => {
  fakerFR.seed(7);
  const a = fakerFR.number.int();
  fakerFR.seed(7);
  keep('itself', [a, fakerFR.number.int()]);
});
test.describe('own', () => {
  test.use({ keploySeedRandom: false });
  test('mine', () => { make(); });
});
// Outside every test faker draws its own again.
test.afterAll(() => keep('outside', { own: faker.fakerCore.randomizer.next === own, made: [faker.string.uuid()] }));
