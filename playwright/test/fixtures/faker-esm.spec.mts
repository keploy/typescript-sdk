import fs from 'node:fs';
import { Faker, en, faker } from '@faker-js/faker';
import { seedFaker, test } from '../../dist/index.js';

// faker in a test file Playwright runs as an ES module: the instance it
// imports is the one keploy seeds, and seedFaker is a named import.
const mine = seedFaker(new Faker({ locale: [en] }), 'esm mine');
test('esm made', () => {
  fs.writeFileSync(`${process.env.MARKER_DIR}/faker-esm made.json`, JSON.stringify([faker.string.uuid(), faker.string.uuid(), mine.string.uuid()]));
});
