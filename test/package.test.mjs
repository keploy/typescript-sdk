// Rows for @keploy/sdk as a user gets it: what its built code requires, and
// its entry points loaded from a clean install of its packed tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = ['@keploy/sdk', '@keploy/sdk/dist/v2/dedup/middleware', '@keploy/sdk/dist/v2/dedup/register'];

// The .js files under dir, at any depth.
function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scripts(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
}

test('every package the built code requires is a dependency', () => {
  assert.ok(existsSync(join(root, 'dist/keployCli.js')), 'dist/ is built (npm ci runs prepare)');
  const required = new Set();
  for (const f of scripts(join(root, 'dist'))) {
    for (const [, spec] of readFileSync(f, 'utf8').matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      if (spec.startsWith('.') || spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      required.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  assert.deepEqual([...required].filter((n) => !(n in pkg.dependencies)), []);
  // The two the dedup entry points need, which 2.0.10 did not declare.
  for (const n of ['body-parser', 'js-yaml']) assert.ok(required.has(n), n);
});

test('the entry points load from a clean install of the packed package', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'sdk-install-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', work], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const tgz = join(work, packed.stdout.trim().split('\n').pop());
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0', private: true }));
  const inst = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz], { cwd: app, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  for (const e of entries) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(e)})`], { cwd: app, encoding: 'utf8' });
    assert.equal(r.status, 0, `${e}: ${r.stderr}`);
  }
});
