'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const table = require('../lib/table');
const sourcemap = require('../lib/sourcemap');
const { frames } = require('../lib/agent');
const { APP, tmpDir } = require('./helpers');

const RUNTIME = 'node 22.11';
const SDK = '0.1.0';
const BUNDLE = path.join(__dirname, 'fixtures', 'bundle');

const build = (root, env = {}, runtime = RUNTIME, sdk = SDK) => table.build(root, env, runtime, sdk);
const unitsOf = (t) => t.ndjson.toString('utf8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const linesOf = (u) => new Set(u.methods.flatMap((m) => m.leaves.map((l) => l[0])));

// The checks keploy's codecoverage.NewTable makes of a node unit
// (checkUnit, methodOf, checkLeaf), so a table this adapter streams is one
// keploy takes.
function checkUnit(u) {
  assert.strictEqual(u.kind, 'file');
  assert.ok(u.name && !u.name.includes('/'), `name ${u.name}`);
  const p = u.pkg ? `${u.pkg}/${u.name}` : u.name;
  assert.strictEqual(u.path, p);
  assert.strictEqual(u.id, `f:${p}`);
  assert.match(u.hash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(Object.keys(u), u.reason
    ? ['kind', 'id', 'pkg', 'name', 'path', 'hash', 'state', 'reason', 'methods']
    : ['kind', 'id', 'pkg', 'name', 'path', 'hash', 'state', 'methods']);
  const lines = new Set();
  let prev = null;
  for (const m of u.methods) {
    assert.deepStrictEqual(Object.keys(m), ['id', 'name', 'line', 'leaves']);
    assert.ok(m.id.startsWith(`m:${p}#`) && m.id.length > `m:${p}#`.length, m.id);
    assert.ok(m.line >= 1);
    if (prev) assert.ok(prev.line < m.line || (prev.line === m.line && Buffer.compare(Buffer.from(prev.id), Buffer.from(m.id)) < 0));
    prev = m;
    let last = 0;
    for (const l of m.leaves) {
      assert.deepStrictEqual(l, [l[0], 0, l[0], 0, 1, 0]);
      assert.ok(l[0] > last, 'leaves ascend');
      last = l[0];
      assert.ok(!lines.has(l[0]), `line ${l[0]} in one method only`);
      lines.add(l[0]);
    }
  }
}

test('the fixture app: units, order, methods and the mapped TypeScript', async () => {
  const t = await build(APP);
  const units = unitsOf(t);
  assert.deepStrictEqual(units.map((u) => u.id), ['f:lib.js', 'f:server.js', 'f:src/price.ts']);
  assert.match(t.build, /^js1-[0-9a-f]{32}$/);
  assert.deepStrictEqual(t.failed, []);
  for (const u of units) checkUnit(u);
  assert.deepStrictEqual(units[0].methods.map((m) => [m.id, m.leaves.map((l) => l[0])]), [
    ['m:lib.js#<module>@1', [1, 14]],
    ['m:lib.js#alpha@4', [4, 5, 6]],
    ['m:lib.js#beta@9', [9, 10, 11]],
  ]);
  const ts = units[2];
  assert.strictEqual(ts.hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(APP, 'src/price.ts'))).digest('hex'));
  const tsLines = linesOf(ts);
  for (const l of [7, 8, 9, 10, 12, 15, 16, 17, 19, 25, 26, 30]) assert.ok(tsLines.has(l), `price.ts:${l} is a line`);
  for (const l of [1, 2, 3, 4, 11, 13]) assert.ok(!tsLines.has(l), `price.ts:${l} is no line`);
  const byMethod = Object.fromEntries(ts.methods.map((m) => [m.name, m.leaves.map((l) => l[0])]));
  assert.ok(byMethod.total.includes(7) && byMethod.total.includes(8) && byMethod.total.includes(12));
  assert.ok(byMethod.discount.includes(19));
  assert.ok(byMethod.add.includes(26));
  // The generated script is no unit; its entries count for the .ts.
  const g = t.gen.get(path.join(fs.realpathSync(APP), 'compiled/price.js'));
  assert.ok(g && g.unitNames.length === 1 && g.unitNames[0] === 'src/price.ts');
  for (let i = 0; i < g.offs.length; i++) {
    assert.strictEqual(t.names[g.units[i]], 'src/price.ts');
    assert.ok(tsLines.has(g.lines[i]));
    if (i) assert.ok(g.offs[i - 1] <= g.offs[i], 'entries sorted by offset');
  }
  assert.strictEqual(t.ndjson.toString('utf8'), units.map((u) => JSON.stringify(u) + '\n').join(''));
});

test('golden: the fixture app has this table and build id (a scanner change bumps TABLE_FORMAT)', async () => {
  const t = await build(APP);
  // Recompute these, and bump TABLE_FORMAT, only on purpose.
  assert.strictEqual(crypto.createHash('sha256').update(t.ndjson).digest('hex'), GOLDEN_TABLE_SHA);
  assert.strictEqual(t.build, GOLDEN_BUILD);
});

test('the build id names the files, the generated JS and maps, the runtime and the adapter', async () => {
  const a = await build(APP);
  assert.strictEqual((await build(APP)).build, a.build, 'one build, one id');
  assert.notStrictEqual((await build(APP, {}, 'node 20.18')).build, a.build);
  assert.notStrictEqual((await build(APP, {}, RUNTIME, '0.1.1')).build, a.build);
  const dir = tmpDir();
  fs.cpSync(APP, dir, { recursive: true, preserveTimestamps: true });
  assert.strictEqual((await build(dir)).build, a.build, 'the same files elsewhere are the same build');
  // The generated JS changes, the original does not: another build.
  fs.appendFileSync(path.join(dir, 'compiled/price.js'), '\n');
  const b = await build(dir);
  assert.notStrictEqual(b.build, a.build);
  fs.appendFileSync(path.join(dir, 'lib.js'), '\n// changed\n');
  assert.notStrictEqual((await build(dir)).build, b.build);
});

test('exclusions: tests, root configs, node_modules, hidden dirs, the root coverage/, KEPLOY_COVERAGE_EXCLUDE', async () => {
  const dir = tmpDir();
  const put = (rel, text = 'go();\n') => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  for (const rel of ['a.js', 'b.test.js', 'c.spec.mjs', 'jest.config.js', 'x.min.js', 'node_modules/m/i.js',
    '.hidden/h.js', '__tests__/t.js', 'gen/g.js', 'sub/keep.cjs', 'sub/drop.js', 'coverage/lcov.js',
    'src/coverage/policy.js', 'src/db.config.js']) put(rel);
  const t = await build(dir, { KEPLOY_COVERAGE_EXCLUDE: 'gen/**, drop.js' });
  assert.deepStrictEqual(unitsOf(t).map((u) => u.path), ['a.js', 'src/db.config.js', 'src/coverage/policy.js', 'sub/keep.cjs']);
});

test('fail closed: an unreadable map, a minified file with no map, a map of no app file', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'm.js'), 'go();\n//# sourceMappingURL=m.js.map\n');
  fs.writeFileSync(path.join(dir, 'm.js.map'), '{"version":3,"sources":["m.ts"],"mappings":"!!"}');
  fs.writeFileSync(path.join(dir, 'min.js'), `var a=1;${'b();'.repeat(600)}\n`);
  const outside = { version: 3, sources: ['../../elsewhere/x.ts', 'webpack://ns/webpack/bootstrap'], mappings: 'AAAA' };
  fs.writeFileSync(path.join(dir, 'vendor.js'), `go();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(outside)).toString('base64')}\n`);
  const t = await build(dir);
  const units = unitsOf(t);
  assert.deepStrictEqual(units.map((u) => [u.path, u.state, u.reason && u.reason.code, u.methods.length]), [
    ['m.js', 'not_measured', 'analyzer_failed', 0],
    ['min.js', 'not_measured', 'analyzer_failed', 0],
    ['vendor.js', 'not_measured', 'analyzer_failed', 0],
  ]);
  for (const u of units) checkUnit(u);
  assert.strictEqual(units[1].hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'min.js'))).digest('hex'));
  const why = Object.fromEntries(t.failed.map((f) => [f.path, f.why]));
  assert.match(why['m.js'], /source map cannot be read/);
  assert.match(why['min.js'], /minified \(a line of \d+ characters\) and has no source map/);
  assert.match(why['vendor.js'], /names no file of the app/);
  assert.strictEqual(t.gen.size, 0);
  assert.ok(t.notes.some((n) => /elsewhere\/x\.ts is not a file of the app/.test(n)));
});

test('a map whose source is gone, or stale, measures the generated file itself', async () => {
  const dir = tmpDir();
  const map = (extra) => Buffer.from(JSON.stringify({ version: 3, sources: ['orig.ts'], mappings: 'AAAA;AACA', ...extra })).toString('base64');
  fs.mkdirSync(path.join(dir, 'gone'));
  fs.writeFileSync(path.join(dir, 'gone/gen.js'), `go();\nmore();\n//# sourceMappingURL=data:application/json;base64,${map({})}\n`);
  fs.mkdirSync(path.join(dir, 'stale'));
  fs.writeFileSync(path.join(dir, 'stale/orig.ts'), 'go();\nchanged();\n');
  fs.writeFileSync(path.join(dir, 'stale/gen.js'), `go();\nmore();\n//# sourceMappingURL=data:application/json;base64,${map({ sourcesContent: ['go();\nmore();\n'] })}\n`);
  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'content/gen.js'), `go();\nmore();\n//# sourceMappingURL=data:application/json;base64,${map({ sourcesContent: ['go();\nmore();\n'] })}\n`);
  fs.mkdirSync(path.join(dir, 'moved'));
  fs.writeFileSync(path.join(dir, 'moved/orig.ts'), 'go();\n');
  fs.writeFileSync(path.join(dir, 'moved/gen.js'), `go();\nmore();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ['orig.ts'], mappings: 'AAAA;AAEA' })).toString('base64')}\n`);
  const t = await build(dir);
  const units = unitsOf(t);
  // gone/, stale/ and moved/: the generated file; content/: its sourcesContent.
  assert.deepStrictEqual(units.map((u) => [u.path, u.state, [...linesOf(u)]]), [
    ['content/orig.ts', 'ok', [1, 2]],
    ['gone/gen.js', 'ok', [1, 2]],
    ['moved/gen.js', 'ok', [1, 2]],
    ['stale/gen.js', 'ok', [1, 2]],
  ]);
  assert.ok(t.notes.some((n) => /moved\/gen\.js: measured as itself: its map is stale for moved\/orig\.ts \(it maps to places past/.test(n)), t.notes.join('\n'));
  assert.strictEqual(units[0].hash, crypto.createHash('sha256').update('go();\nmore();\n').digest('hex'));
  assert.ok(t.notes.some((n) => /gone\/gen\.js: measured as itself: .*orig\.ts is not on disk/.test(n)), t.notes.join('\n'));
  assert.ok(t.notes.some((n) => /stale\/gen\.js: measured as itself: its map is stale/.test(n)), t.notes.join('\n'));
});

test('bundles: one line and wrapped, and webpack:// sources, map their segments to the originals', async () => {
  const t = await build(BUNDLE);
  const units = unitsOf(t);
  assert.deepStrictEqual(units.map((u) => u.path), ['src/calc.ts', 'src/entry.ts']);
  const calc = units[0];
  const byName = Object.fromEntries(calc.methods.map((m) => [m.name, m.leaves.map((l) => l[0])]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['add', 'mul']);
  assert.ok(byName.add.length && byName.add.every((l) => l >= 2 && l <= 4), `add ${byName.add}`);
  assert.ok(byName.mul.length && byName.mul.every((l) => l >= 7 && l <= 9), `mul ${byName.mul}`);
  for (const f of ['one.js', 'wrapped.js', 'webpack.js']) {
    const g = t.gen.get(path.join(fs.realpathSync(BUNDLE), 'bundled', f));
    assert.ok(g && g.offs.length > 10, `${f} has entries`);
    assert.deepStrictEqual(g.unitNames, ['src/calc.ts', 'src/entry.ts']);
  }
  assert.ok(t.notes.some((n) => /webpack\.js: its map's source webpack:\/\/bundle\/webpack\/bootstrap is not a file of the app/.test(n)));
});

test('the source map decoder reads the tsc map', () => {
  const js = fs.readFileSync(path.join(APP, 'compiled/price.js'), 'utf8');
  const m = sourcemap.load(path.join(APP, 'compiled/price.js'), js, APP);
  assert.deepStrictEqual(m.sources, [path.join(APP, 'src/price.ts')]);
  assert.match(m.sha, /^[0-9a-f]{64}$/);
  const lines = js.split('\n');
  const at = (needle) => {
    const g = lines.findIndex((l) => l.includes(needle));
    return sourcemap.lookup(m.lines, g, lines[g].indexOf(needle));
  };
  assert.deepStrictEqual(at('return sum;'), [0, 11]);
  assert.deepStrictEqual(at('let sum = 0;'), [0, 7]);
  assert.deepStrictEqual(at('this.items.push(item);'), [0, 25]);
  assert.deepStrictEqual(at('return cents;'), [0, 16]);
});

test('sources: sourceRoot, file: URLs with escapes, webpack:// namespaces', () => {
  const root = '/app';
  assert.strictEqual(sourcemap.resolveSource('a.ts', root, '/app/dist', '../src'), '/app/src/a.ts');
  assert.strictEqual(sourcemap.resolveSource('a.ts', root, '/app/dist', '../src/'), '/app/src/a.ts');
  assert.strictEqual(sourcemap.resolveSource('file:///app/my%20dir/a.ts', root, '/x', ''), '/app/my dir/a.ts');
  assert.strictEqual(sourcemap.resolveSource('webpack://ns/./src/a.ts', root, '/x', ''), '/app/src/a.ts');
  assert.strictEqual(sourcemap.resolveSource('webpack:///./src/a.ts', root, '/x', ''), '/app/src/a.ts');
  assert.strictEqual(sourcemap.resolveSource('webpack://ns/src/a.ts?abcd', root, '/x', ''), '/app/src/a.ts');
  assert.strictEqual(sourcemap.resolveSource('webpack://ns/webpack/bootstrap', root, '/x', ''), null);
  assert.strictEqual(sourcemap.resolveSource('webpack://ns/external "express"', root, '/x', ''), null);
  assert.strictEqual(sourcemap.resolveSource('https://x/a.ts', root, '/x', ''), null);
});

test('an index map (sections) is read, each section shifted by its offset', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one();\n');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'two();\n');
  const map = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], mappings: 'AAAA' } },
      { offset: { line: 1, column: 4 }, map: { version: 3, sources: ['b.ts'], mappings: 'AAAA,EAAA' } },
    ],
  };
  const js = `one();\nxx; two();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
  const m = sourcemap.load(path.join(dir, 'gen.js'), js, dir);
  assert.deepStrictEqual(m.sources, [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')]);
  assert.deepStrictEqual(m.lines, [[[0, 0, 0, 0]], [[4, 1, 0, 0], [6, 1, 0, 0]]]);
});

test('VLQ: known values and malformed input', () => {
  // A = 0, C = 1, D = -1, gB = 16; a new line resets the column only.
  assert.deepStrictEqual(sourcemap.decodeMappings('AAAC,CACD;gBAAC'), [
    [[0, 0, 0, 1], [1, 0, 1, 0]],
    [[16, 0, 1, 1]],
  ]);
  assert.deepStrictEqual(sourcemap.decodeMappings('E;;A'), [[[2, -1, 0, 0]], [], [[0, -1, 0, 0]]]);
  assert.throws(() => sourcemap.decodeMappings('AA'), /2 fields/);
  assert.throws(() => sourcemap.decodeMappings('g'), /cut VLQ/);
  assert.throws(() => sourcemap.decodeMappings('A!'), /not base64/);
  assert.throws(() => sourcemap.decodeMappings('AAAD'), /negative/);
});

test('methods: a line goes to the innermost function', () => {
  const src = 'function outer() {\n  const x = 1;\n  function inner() {\n    return x;\n  }\n  return inner();\n}\n';
  const m = table.methodsOf('n.js', src, new Set([1, 2, 3, 4, 6]));
  assert.deepStrictEqual(m.map((x) => [x.name, x.leaves.map((l) => l[0])]), [['outer', [1, 2, 6]], ['inner', [3, 4]]]);
});

test('a BOM: entries are at the offsets Node runs (the BOM cut)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'b.js'), '\ufeffgo();\n');
  const a = table.analyzeScript(dir, 'b.js', () => false);
  assert.deepStrictEqual(a.entries, [{ off: 0, unit: 'b.js', line: 1 }]);
});

test('a file past the size bound is not measured, and said', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'big.js'), 'x();\n'.repeat((table.MAX_FILE_BYTES / 5) + 10));
  const t = await build(dir);
  assert.deepStrictEqual(unitsOf(t).map((u) => [u.path, u.state]), [['big.js', 'not_measured']]);
  assert.match(t.failed[0].why, /cannot be read: \d+ bytes, more than/);
});

test('frames: one part in frames of at most 1 MiB, the last naming count and sha256', () => {
  const payload = Buffer.from('x'.repeat(700 << 10) + '\n' + 'y'.repeat(600 << 10) + '\n');
  const fs_ = frames('table', 'js1-' + '0'.repeat(32), payload);
  assert.strictEqual(fs_.length, 3);
  const all = [];
  fs_.forEach((f, i) => {
    assert.strictEqual(f.subarray(0, 4).toString('latin1'), 'KTB1');
    const n = f.readUInt32BE(4);
    assert.strictEqual(n + 8, f.length);
    assert.ok(f.length <= 1 << 20);
    const body = f.subarray(8);
    const nl = body.indexOf(0x0a);
    const hd = JSON.parse(body.subarray(0, nl));
    assert.strictEqual(hd.seq, i);
    assert.strictEqual(hd.last, i === 2);
    if (hd.last) {
      assert.strictEqual(hd.records, 2);
      assert.strictEqual(hd.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    } else {
      assert.strictEqual(hd.records, undefined);
    }
    all.push(body.subarray(nl + 1));
  });
  assert.ok(Buffer.concat(all).equals(payload));
  const empty = frames('probes', 'b', Buffer.alloc(0));
  assert.strictEqual(empty.length, 1);
  const body = empty[0].subarray(8);
  assert.deepStrictEqual(JSON.parse(body.subarray(0, body.indexOf(0x0a))), {
    v: 1, part: 'probes', build: 'b', seq: 0, last: true, records: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
});

const GOLDEN_TABLE_SHA = 'ccabe2de7c549939af6e670735b5c489b874b4903fb7ab71443e04c926674593';
const GOLDEN_BUILD = 'js1-211d1e750fb3c8203e0d0bc92faff6bd';

test('mapped sources under node_modules, hidden dirs or excluded are left out, and said', () => {
  const dir = tmpDir();
  for (const rel of ['src/ok.ts', 'src/x.test.ts', 'node_modules/lib/x.ts', '.cache/y.ts']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'go();\n');
  }
  const map = { version: 3, sources: ['src/ok.ts', 'src/x.test.ts', 'node_modules/lib/x.ts', '.cache/y.ts'], mappings: 'AAAA,CCAA,CCAA,CCAA' };
  fs.writeFileSync(path.join(dir, 'gen.js'), `go(); a(); b(); c();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`);
  const a = table.analyzeScript(fs.realpathSync(dir), 'gen.js', table.excluder({}));
  assert.deepStrictEqual([...a.units.keys()], ['src/ok.ts']);
  assert.deepStrictEqual(a.entries.map((e) => e.unit), ['src/ok.ts']);
  assert.strictEqual(a.notes.length, 3, a.notes.join('\n'));
});

test('one file read as two texts (two maps carry two contents for it) is not measured', async () => {
  const dir = tmpDir();
  const gen = (name, content) => {
    const map = { version: 3, sources: ['orig.ts'], sourcesContent: [content], mappings: 'AAAA' };
    fs.writeFileSync(path.join(dir, name), `go();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`);
  };
  gen('a.js', 'go();\n');
  gen('b.js', 'go();\nmore();\n');
  const t = await build(dir);
  assert.deepStrictEqual(unitsOf(t).map((u) => [u.path, u.state]), [['orig.ts', 'not_measured']]);
  assert.match(t.failed[0].why, /read as two different texts/);
  assert.strictEqual(t.gen.size, 0);
});

test('a file whose name holds a backslash or a control character is left out, and said', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ok.js'), 'go();\n');
  fs.writeFileSync(path.join(dir, 'a\\b.js'), 'go();\n');
  fs.writeFileSync(path.join(dir, 'c\u0007.js'), 'go();\n');
  const t = await build(dir);
  assert.deepStrictEqual(unitsOf(t).map((u) => u.path), ['ok.js']);
  assert.strictEqual(t.notes.filter((n) => /holds a backslash or a control character/.test(n)).length, 2, t.notes.join('\n'));
  assert.strictEqual(t.appScript(path.join(fs.realpathSync(dir), 'a\\b.js')), null);
  assert.strictEqual(t.appScript(path.join(fs.realpathSync(dir), 'ok.js')), null, 'a file the table holds');
  assert.strictEqual(t.appScript(path.join(fs.realpathSync(dir), 'new.js')), 'new.js');
  assert.strictEqual(t.appScript(path.join(fs.realpathSync(dir), 'x.test.js')), null, 'excluded by name');
  assert.strictEqual(t.appScript(path.join(fs.realpathSync(dir), 'node_modules/m.js')), null);
});
