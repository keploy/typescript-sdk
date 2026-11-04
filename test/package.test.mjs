// Rows for @keploy/sdk as a user gets it: what its built code requires, and
// its entry points loaded from a clean install of its packed tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
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
  // The one the dedup entry points need, which 2.0.10 did not declare; and
  // no YAML package: the middleware writes its entries with our own code.
  assert.ok(required.has('body-parser'));
  for (const n of ['yaml', 'js-yaml']) assert.ok(!required.has(n) && !(n in pkg.dependencies), n);
});

// A clean install of the packed package, as a user's app gets it.
const work = mkdtempSync(join(tmpdir(), 'sdk-install-'));
test.after(() => rmSync(work, { recursive: true, force: true }));
const app = join(work, 'app');
const readers = join(work, 'readers');
const reader = (v) => createRequire(join(readers, 'package.json'))(`js-yaml-${v}`);
test.before(() => {
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', work], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const tgz = join(work, packed.stdout.trim().split('\n').pop());
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0', private: true }));
  const inst = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz], { cwd: app, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  // The YAML readers a user's app may have had: js-yaml 3 (nyc's) and 4.
  mkdirSync(readers);
  writeFileSync(join(readers, 'package.json'), JSON.stringify({ name: 'readers', version: '0.0.0', private: true }));
  const r = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', 'js-yaml-3@npm:js-yaml@3.15.2', 'js-yaml-4@npm:js-yaml@4.3.2'], { cwd: readers, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the entry points load from a clean install of the packed package', () => {
  for (const e of entries) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(e)})`], { cwd: app, encoding: 'utf8' });
    assert.equal(r.status, 0, `${e}: ${r.stderr}`);
  }
  for (const n of ['yaml', 'js-yaml', 'esprima']) assert.ok(!existsSync(join(app, 'node_modules', n)), `${n} is installed`);
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

// The middleware's request: test-set-0/test-3, with lines 1 and 4 of each
// file in files run.
const REQUEST = (files) => `
  global.__coverage__ = Object.fromEntries(${JSON.stringify(files)}.map((f) => [f, { statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 4 } }, 2: { start: { line: 9 } } }, s: { 0: 1, 1: 2, 2: 0 } }]));
  const res = new (require('events').EventEmitter)();
  const h = { 'KEPLOY-TEST-ID': 'test-3', 'KEPLOY-TEST-SET-ID': 'test-set-0' };
  require('@keploy/sdk/dist/v2/dedup/middleware')()({ get: (n) => h[n] }, res, () => {});
`;

// Runs the installed middleware on one request in a folder holding seed as
// dedupData.yaml, and returns the file it leaves.
function request(seed, files = ['/home/runner/app/src/index.js']) {
  const cwd = mkdtempSync(join(app, 'run-'));
  writeFileSync(join(cwd, 'dedupData.yaml'), seed);
  const r = spawnSync(process.execPath, ['-e', REQUEST(files) + "res.emit('finish');"], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(cwd, 'dedupData.yaml'), 'utf8');
}

test('the middleware appends to dedupData.yaml as 2.0.10 wrote it, and js-yaml 3 and 4 read it back the same', () => {
  const entry = (id, executedLinesByFile) => ({ id, executedLinesByFile });
  const want = [
    entry('test-set-0/test-1', { '/home/runner/app/src/index.js': [1, 2, 5, 12], '/home/runner/app/src/routes/user routes.js': [] }),
    entry('undefined/test-2', { [String.raw`C:\Users\dev\app\src\index.js`]: [3], '/app/src/ünïcode/日本.js': [7, 8] }),
    entry('test-set-0/test-3', { '/home/runner/app/src/index.js': [1, 4] }),
  ];
  for (const seed of [JS_YAML_3, JS_YAML_4]) {
    const file = request(seed);
    assert.equal(file, seed + ADDED);
    for (const v of [3, 4]) assert.deepStrictEqual(reader(v).load(file), want, `js-yaml ${v}`);
  }
  assert.equal(request(''), ADDED);
  // A name a YAML 1.1 reader takes for a boolean or a date is quoted, as
  // js-yaml quoted it.
  const lines = '\n      - 1\n      - 4\n';
  assert.equal(request('', ['no', '2026-11-04']), `- id: test-set-0/test-3\n  executedLinesByFile:\n    'no':${lines}    '2026-11-04':${lines}`);
});

test('the middleware leaves what the file holds as it is, and loads none of it', () => {
  const tags = "- id: a/b\n  executedLinesByFile: !!js/function 'function () { return 42 }'\n- !!js/regexp /x/\n- !!js/undefined ''\n";
  assert.equal(request(tags), tags + ADDED);
});

test('on a file of 1000 entries, a request reads nothing from it and writes only its own entry', () => {
  const cwd = mkdtempSync(join(app, 'big-'));
  // 1000 tests, each with 60 lines run in each of 40 files: 28 MiB.
  const body = Array.from({ length: 40 }, (_, f) => `    /home/runner/app/src/file-${f}.js:\n` + Array.from({ length: 60 }, (_, l) => `      - ${l + 1}\n`).join('')).join('');
  const seed = Array.from({ length: 1000 }, (_, t) => `- id: test-set-0/test-${t}\n  executedLinesByFile:\n${body}`).join('');
  writeFileSync(join(cwd, 'dedupData.yaml'), seed);
  // Every call into fs the request makes (not those one of them makes), with
  // its first argument and the size of its second.
  const r = spawnSync(process.execPath, ['-e', REQUEST(['/home/runner/app/src/index.js']) + `
    const fs = require('fs');
    const calls = [];
    const saved = {};
    let depth = 0;
    for (const k of Object.keys(fs)) {
      if (typeof fs[k] !== 'function' || /^[A-Z]/.test(k)) continue;
      const f = (saved[k] = fs[k]);
      fs[k] = function (...a) {
        if (depth === 0) calls.push([k, a[0], typeof a[1] === 'string' ? Buffer.byteLength(a[1]) : a[1] && a[1].length]);
        depth++;
        try { return f.apply(this, a); } finally { depth--; }
      };
    }
    res.emit('finish');
    Object.assign(fs, saved);
    process.stdout.write(JSON.stringify(calls));
  `], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [['appendFileSync', 'dedupData.yaml', Buffer.byteLength(ADDED)]]);
  assert.ok(readFileSync(join(cwd, 'dedupData.yaml'), 'utf8') === seed + ADDED, 'the file is the seed, then the new entry');
});

// Names and ids a coverage tool and a request can give, YAML's own words,
// indicators and escapes among them, and lines.
const NAMES = ['/home/runner/app/src/index.js', String.raw`C:\Users\dev\app\src\index.js`, '/a b/c.js', '/app/ünïcode/日本.js', '/x/😀.js',
  'a#b', 'a #b', 'a: b', 'a:b', 'a:', 'a ', ' a', ' ', ':', '-a', '- a', '?a', ':a', ',a', '[a]', '{a}', '#a', '&a', '*a', '!a', '|a', '=a', '>a', "'a", '"a', '%a', '@a', '`a',
  "it's", 'a"b', 'a\\b', 'no', 'No', 'NO', 'yes', 'y', 'n', 'on', 'off', 'OFF', 'true', 'True', 'false', 'null', 'Null', 'NULL', '~', '', '<<', '0o12', '+0o7', '1_000', '+.5', '.5', '08',
  '0x1F', '0b101', '1:20', '_:_', '1:20.5', '2026-11-04', '2026-11-04T10:00:00Z', '.inf', '-.inf', '.NaN', '.nan', '1e5', '123', '-1', '...', '---',
  'a\tb', 'a\nb', 'a\rb', '\x00', '\x7f', '\x85', 'a\xa0b', '\u2028', 'a\u2029b', 'a\ufeffb', '\ufeffa', 'a\ud800b', '\ud83d', 'a\x1fb', 'a~b', 'a\xa1b', 'a\ud7ffb', 'a\ue000b',
  'a\ufffdb', 'a\ufffeb', 'a\x80b', 'a\x01b', 'a\t"\\b', '\x1b\x07\x08\x0b\x0c',
  'x'.repeat(1023) + "'", 'x'.repeat(1024), 'x'.repeat(1025), "'".repeat(600), '/p/' + 'q'.repeat(2000)];
const LINES = [1, 2, 0, 12, 1.5, NaN, Infinity, -Infinity, -0, 1e-7, 1e21, 2 ** 53, -3];

test('each entry is the text js-yaml 4 wrote but where the limits say, and js-yaml 3 and 4 read back its values', () => {
  const { entryYaml } = createRequire(join(app, 'package.json'))('@keploy/sdk/dist/v2/dedup/entry');
  const short = (s) => JSON.stringify(s).slice(0, 24);
  const cases = [
    ...NAMES.flatMap((s) => [[`key ${short(s)}`, 't/1', { [s]: [1, 4] }], [`empty ${short(s)}`, 't/1', { [s]: [] }], [`id ${short(s)}`, s, { '/a.js': [1] }]]),
    ...LINES.map((n) => [`line ${n}`, 't/1', { '/a.js': [n] }]),
    ['no files', 't/1', {}], ['not numbers', 't/1', { '/a.js': ['5', null, undefined, true] }],
    ['three files', 'undefined/test-2', { '/a.js': [1, 2], 'C:\\x.js': [], '/b.js': [3] }],
    ...[76, 77].flatMap((n) => [[`id of ${n}`, 'i'.repeat(n), {}], [`id of ${n} after a space`, ' ' + 'i'.repeat(n), {}]]),
  ];
  const differ = [];
  for (const [label, id, lines] of cases) {
    const text = entryYaml(id, lines);
    const theirs = reader(4).dump([{ id, executedLinesByFile: lines }]);
    for (const v of [3, 4]) {
      let got;
      assert.doesNotThrow(() => { got = reader(v).load(text); }, `${label}: js-yaml ${v} reads it`);
      assert.deepStrictEqual(got, reader(4).load(theirs), `${label}: js-yaml ${v}`);
    }
    if (text !== theirs) differ.push(label);
  }
  // The limits: names that start like a number, ids js-yaml 4 writes as a
  // block, and lines that are not numbers.
  const x = `id "${'x'.repeat(23)}`;
  assert.deepEqual(differ, ['key "1_000"', 'empty "1_000"', 'id "1_000"', 'key "+.5"', 'empty "+.5"', 'id "+.5"', 'id "a\\nb"',
    x, x, x, `id "${"'".repeat(23)}`, 'id "/p/qqqqqqqqqqqqqqqqqqqq', 'not numbers', 'id of 77']);
});
