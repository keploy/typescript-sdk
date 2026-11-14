import { faker } from '@faker-js/faker';
import { test } from '../../dist';

// A test that draws in its test process (Math.random and faker) and in its
// page, whose page puts in frames at one path. NOTE_MORE=1 draws Math.random
// once more in each and getRandomValues twice more in the page, and puts in
// one more frame, as a replay that draws otherwise than its recording does.
const more = process.env.NOTE_MORE === '1' ? 1 : 0;

test('noted', async ({ page }) => {
  for (let i = 0; i <= more; i++) Math.random();
  faker.person.firstName();
  // goto waits for the frames' loads, and so for their draws.
  await page.goto(`${process.env.DRAWS_BASE}/note?frames=${1 + more}&draws=${more}`);
});

// A page that puts in a frame before it draws, and never draws itself.
test('plain', async ({ page }) => {
  await page.goto(`${process.env.DRAWS_BASE}/notef`);
});

// A document seeding cannot place (a CSP sandbox: no session storage),
// which puts in a frame.
test('unplaced', async ({ page }) => {
  await page.goto(`${process.env.DRAWS_BASE}/cspf`);
});
