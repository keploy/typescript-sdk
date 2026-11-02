// Rows for the publish workflow's version check (scripts/release-version.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { refusal } from '../scripts/release-version.mjs';

const script = fileURLToPath(new URL('../scripts/release-version.mjs', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('a tag naming the version publishes', () => {
  assert.equal(refusal('jest-v1.2.3', '1.2.3'), '');
});

test('a tag naming another version is refused, and names the right tag', () => {
  assert.match(refusal('jest-v1.2.4', '1.2.3'), /does not name package\.json's version 1\.2\.3: the tag for it is jest-v1\.2\.3$/);
  assert.match(refusal('jest-v1.2.3.1', '1.2.3'), /does not name/);
  assert.match(refusal('v1.2.3', '1.2.3'), /does not name/);
  assert.match(refusal('', '1.2.3'), /the tag \(none\) does not name/);
});

test('a prerelease version is refused, even with its own tag', () => {
  assert.match(refusal('jest-v1.2.3-rc.1', '1.2.3-rc.1'), /is not a release \(x\.y\.z\)/);
  assert.match(refusal('jest-v1.2', '1.2'), /is not a release/);
});

test('the script reads package.json and exits 1 with the reason on a wrong tag', () => {
  const ok = run(`jest-v${version}`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout + ok.stderr, '');
  const bad = run('jest-v0.0.0-not-this');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, new RegExp(`^refusing to publish: the tag jest-v0\\.0\\.0-not-this does not name package\\.json's version ${version.replace(/\./g, '\\.')}`));
  const none = run();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /the tag \(none\)/);
});
