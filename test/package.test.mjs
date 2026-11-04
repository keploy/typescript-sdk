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
  for (const n of ['body-parser', 'yaml']) assert.ok(required.has(n), n);
});

// A clean install of the packed package, as a user's app gets it.
const work = mkdtempSync(join(tmpdir(), 'sdk-install-'));
test.after(() => rmSync(work, { recursive: true, force: true }));
const app = join(work, 'app');
test.before(() => {
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', work], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const tgz = join(work, packed.stdout.trim().split('\n').pop());
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0', private: true }));
  const inst = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz], { cwd: app, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
});

test('the entry points load from a clean install of the packed package', () => {
  for (const e of entries) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(e)})`], { cwd: app, encoding: 'utf8' });
    assert.equal(r.status, 0, `${e}: ${r.stderr}`);
  }
});

// dedupData.yaml as 2.0.10's middleware wrote it, with js-yaml 3.15.2 and
// with js-yaml 4.3.2 (whichever the app had), before a request and after
// one more (test-set-0/test-3, lines 1 and 4 of index.js run).
const BEFORE = (winKey) => `- id: test-set-0/test-1
  executedLinesByFile:
    /home/runner/app/src/index.js:
      - 1
      - 2
      - 5
      - 12
    /home/runner/app/src/routes/user routes.js: []
- id: undefined/test-2
  executedLinesByFile:
    ${winKey}:
      - 3
    /app/src/ünïcode/日本.js:
      - 7
      - 8
`;
const JS_YAML_3 = BEFORE(String.raw`'C:\Users\dev\app\src\index.js'`);
const JS_YAML_4 = BEFORE(String.raw`C:\Users\dev\app\src\index.js`);
const ADDED = `- id: test-set-0/test-3
  executedLinesByFile:
    /home/runner/app/src/index.js:
      - 1
      - 4
`;

// Runs the installed middleware on one request in a folder holding seed as
// dedupData.yaml, with lines 1 and 4 of each file in files run, and returns
// the file it leaves.
function request(seed, files = ['/home/runner/app/src/index.js']) {
  const cwd = mkdtempSync(join(app, 'run-'));
  writeFileSync(join(cwd, 'dedupData.yaml'), seed);
  const r = spawnSync(process.execPath, ['-e', `
    global.__coverage__ = Object.fromEntries(${JSON.stringify(files)}.map((f) => [f, { statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 4 } }, 2: { start: { line: 9 } } }, s: { 0: 1, 1: 2, 2: 0 } }]));
    const res = new (require('events').EventEmitter)();
    const h = { 'KEPLOY-TEST-ID': 'test-3', 'KEPLOY-TEST-SET-ID': 'test-set-0' };
    require('@keploy/sdk/dist/v2/dedup/middleware')()({ get: (n) => h[n] }, res, () => {});
    res.emit('finish');
  `], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(cwd, 'dedupData.yaml'), 'utf8');
}

test('the middleware reads dedupData.yaml as 2.0.10 wrote it, and writes it as js-yaml 4 did', () => {
  for (const seed of [JS_YAML_3, JS_YAML_4]) assert.equal(request(seed), JS_YAML_4 + ADDED);
  assert.equal(request(''), ADDED);
  // A name a YAML 1.1 reader takes for a boolean or a date is quoted, as
  // js-yaml quoted it.
  const lines = '\n      - 1\n      - 4\n';
  assert.equal(request('', ['no', '2026-11-04']), `- id: test-set-0/test-3\n  executedLinesByFile:\n    'no':${lines}    '2026-11-04':${lines}`);
});

test('the middleware loads no js/ tag as code', () => {
  const file = request("- id: a/b\n  executedLinesByFile: !!js/function 'function () { return 42 }'\n- !!js/regexp /x/\n- !!js/undefined ''\n");
  assert.equal(file, "- id: a/b\n  executedLinesByFile: function () { return 42 }\n- /x/\n- ''\n" + ADDED);
});
