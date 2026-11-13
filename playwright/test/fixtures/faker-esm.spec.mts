import fs from 'node:fs';
import { faker } from '@faker-js/faker';
import { test } from '../../dist/index.js';

// faker in a test file Playwright runs as an ES module: the instance it
// imports is the one keploy seeds.
test('esm made', () => {
  fs.writeFileSync(`${process.env.MARKER_DIR}/faker-esm made.json`, JSON.stringify([faker.string.uuid(), faker.string.uuid()]));
});
