// Rows for scripts/license-gate.mjs run as the publish workflow runs it: on a
// tarball `npm pack` wrote. Each row packs a small package of its own (no
// dependencies, so npm needs no registry), then runs the script on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/license-gate.mjs', import.meta.url));

const work = mkdtempSync(join(tmpdir(), 'license-gate-cli-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

// Packs a package named name from files, and returns the tarball's path.
function pack(name, files) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body));
  const r = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return join(work, r.stdout.trim().split('\n').pop());
}

// Runs the script with its own TMPDIR, so a row can see what it leaves there.
function run(args, env = {}) {
  const tmp = mkdtempSync(join(work, 'tmp-'));
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, ...env } });
  // npm keeps caches of its own there (node-compile-cache): only the script's
  // project counts.
  return { ...r, left: readdirSync(tmp).filter((n) => n.startsWith('license-gate-')) };
}

test('a clean package passes, and the project it was installed into is gone', () => {
  const tgz = pack('clean', { 'package.json': { name: 'clean', version: '1.0.0', license: 'Apache-2.0' }, 'index.js': 'module.exports = 1;' });
  const r = run([tgz]);
  assert.equal(r.status, 0, r.stderr);
  // The files: the package's two and what npm writes beside them.
  assert.match(r.stdout, new RegExp(`^license gate: ${tgz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: 1 packages, \\d+ files, every license allowed\n$`));
  assert.deepEqual(r.left, []);
});

test('a package whose license field is not allowed fails, named', () => {
  const tgz = pack('red', { 'package.json': { name: 'red', version: '1.0.0', license: 'GPL-3.0' } });
  const r = run([tgz]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /would ship \d+ license finding\(s\) in 1 packages:\n/);
  assert.match(r.stderr, /\n {2}node_modules\/red \(red@1\.0\.0\): license "GPL-3\.0" is not allowed \(field "GPL-3\.0"\)\n/);
  assert.deepEqual(r.left, []);
});

test('a package carrying a flagged file fails, with the file named', () => {
  const tgz = pack('notice', {
    'package.json': { name: 'notice', version: '1.0.0', license: 'MIT' },
    'ThirdPartyNoticeText.txt': 'UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE\nSee Terms of Use at http://www.unicode.org/copyright.html',
  });
  const r = run([tgz]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\n {2}node_modules\/notice\/ThirdPartyNoticeText\.txt: Unicode terms \("UNICODE, INC\. LICENSE AGREEMENT"\)\n/);
  assert.match(r.stderr, /\n {2}node_modules\/notice\/ThirdPartyNoticeText\.txt: Unicode terms \("unicode\.org\/copyright"\)\n/);
});

test('a file that is not a package fails at the install', () => {
  const bad = join(work, 'not-a-package.tgz');
  writeFileSync(bad, 'not a tarball');
  const r = run([bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^license gate: npm install .*not-a-package\.tgz failed \(exit \d+\): /);
  assert.deepEqual(r.left, []);
});

test('no tarball, or one that is not there, fails before any install', () => {
  const none = run([]);
  assert.equal(none.status, 1);
  assert.equal(none.stderr, 'license gate: no package to check (no TARBALL given)\n');
  const missing = run([join(work, 'missing.tgz')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, `license gate: no package to check (${join(work, 'missing.tgz')})\n`);
  assert.deepEqual(missing.left, []);
});

test('an install that puts nothing on disk fails: nothing checked is not clean', () => {
  // npm_config_dry_run, set in a job's environment, makes `npm install` exit
  // 0 having installed nothing.
  const tgz = pack('dry', { 'package.json': { name: 'dry', version: '1.0.0', license: 'MIT' } });
  const r = run([tgz], { npm_config_dry_run: 'true' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `license gate: installing ${tgz} put no package on disk\n`);
  assert.deepEqual(r.left, []);
});
