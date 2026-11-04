// Rows for scripts/license-gate.mjs run as the publish workflows run it: on a
// tarball `npm pack` wrote. Each row packs small packages of its own (their
// dependencies are tarballs too, named by path, so npm needs no registry),
// then runs the script on one.
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
  // projects count.
  return { ...r, left: readdirSync(tmp).filter((n) => n.startsWith('license-gate-')) };
}

const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const counts = (n) => ['linux/x64', 'linux/arm64', 'darwin/arm64', 'darwin/x64', 'win32/x64'].map((p) => `${p}: ${n} packages, \\d+ files`).join('; ');

test('a clean package passes on every platform, and the projects it was installed into are gone', () => {
  const tgz = pack('clean', { 'package.json': { name: 'clean', version: '1.0.0', license: 'Apache-2.0' }, 'index.js': 'module.exports = 1;' });
  const r = run([tgz]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^license gate: ${quote(tgz)}: ${counts(1)}; every license allowed\n$`));
  assert.deepEqual(r.left, []);
});

test('a package whose license field is not allowed fails, named', () => {
  const tgz = pack('red', { 'package.json': { name: 'red', version: '1.0.0', license: 'GPL-3.0' } });
  const r = run([tgz]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /would ship \d+ license finding\(s\):\n/);
  assert.match(r.stderr, /\n {2}node_modules\/red \(red@1\.0\.0\): license "GPL-3\.0" is not allowed \(field "GPL-3\.0"\)\n/);
  assert.match(r.stderr, new RegExp(`\nchecked ${counts(1)}\n$`));
  assert.deepEqual(r.left, []);
});

test('a package carrying a flagged file fails, with the file named', () => {
  const tgz = pack('notice', {
    'package.json': { name: 'notice', version: '1.0.0', license: 'MIT' },
    'ThirdPartyNoticeText.txt': 'UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE\nSee Terms of Use at http://www.unicode.org/copyright.html',
  });
  const r = run([tgz]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\n {2}node_modules\/notice\/ThirdPartyNoticeText\.txt: Unicode terms \("unicode, inc license agreement"\)\n/);
  assert.match(r.stderr, /\n {2}node_modules\/notice\/ThirdPartyNoticeText\.txt: Unicode terms \("unicode org\/copyright"\)\n/);
});

test('optional dependencies, those of other platforms, and the peers of dependencies are installed and checked', () => {
  const dep = (name, extra) => pack(name, { 'package.json': { name, version: '1.0.0', ...extra } });
  const opt = dep('redopt', { license: 'GPL-3.0' });
  const darwin = dep('reddarwin', { license: 'LGPL-3.0', os: ['darwin'], cpu: ['arm64'] });
  const win = dep('redwin', { license: 'MPL-2.0', os: ['win32'] });
  const peer = dep('redpeer', { license: 'EPL-2.0' });
  const mid = dep('mid', { license: 'MIT', peerDependencies: { redpeer: `file:${peer}` } });
  // The user's own peer needs redpeer too: it is checked all the same.
  const own = dep('ownpeer', { license: 'SSPL-1.0', dependencies: { redpeer: `file:${peer}` } });
  const tgz = pack('top', {
    'package.json': {
      name: 'top', version: '1.0.0', license: 'MIT',
      dependencies: { mid: `file:${mid}` },
      optionalDependencies: { redopt: `file:${opt}`, reddarwin: `file:${darwin}`, redwin: `file:${win}` },
      // The package's own peer is the user's: named, not checked.
      peerDependencies: { ownpeer: `file:${own}` },
    },
  });
  const r = run([tgz]);
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stderr.split('\n').filter((l) => / is not allowed /.test(l)).sort();
  assert.deepEqual(lines, [
    '  node_modules/reddarwin (reddarwin@1.0.0): license "LGPL-3.0" is not allowed (field "LGPL-3.0") (on darwin/arm64)',
    '  node_modules/redopt (redopt@1.0.0): license "GPL-3.0" is not allowed (field "GPL-3.0")',
    '  node_modules/redpeer (redpeer@1.0.0): license "EPL-2.0" is not allowed (field "EPL-2.0")',
    '  node_modules/redwin (redwin@1.0.0): license "MPL-2.0" is not allowed (field "MPL-2.0") (on win32/x64)',
  ]);
  assert.match(r.stderr, /\nchecked linux\/x64: 4 packages, \d+ files; linux\/arm64: 4 packages, \d+ files; darwin\/arm64: 5 packages, \d+ files; darwin\/x64: 4 packages, \d+ files; win32\/x64: 5 packages, \d+ files; not checked, the user's own: 1 packages its peerDependencies install \(ownpeer@1\.0\.0\)\n$/);
  assert.deepEqual(r.left, []);
});

test('a file that is not a package fails at the install', () => {
  const bad = join(work, 'not-a-package.tgz');
  writeFileSync(bad, 'not a tarball');
  const r = run([bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^license gate: npm install .*not-a-package\.tgz for linux\/x64 failed \(exit \d+\): /);
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
  // 0 having installed and saved nothing.
  const tgz = pack('dry', { 'package.json': { name: 'dry', version: '1.0.0', license: 'MIT' } });
  const r = run([tgz], { npm_config_dry_run: 'true' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `license gate: installing ${tgz} for linux/x64 saved 0 packages to the project, not 1\n`);
  assert.deepEqual(r.left, []);
});
