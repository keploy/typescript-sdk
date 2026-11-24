'use strict';
const test = require('node:test');
const assert = require('node:assert');
const scan = require('../lib/scan');

// coverable(src) -> the 1-based lines read as code.
function coverable(src) {
  return scan.read(src).lines.map((l, i) => (l.first >= 0 ? i + 1 : 0)).filter(Boolean);
}

test('comments, blank lines and bracket-only lines are not code', () => {
  const src = [
    '// a comment',             // 1
    'const a = 1; // trailing', // 2
    '/* block',                 // 3
    '   still comment */',      // 4
    'function f() {',           // 5
    '',                         // 6
    '  return a;',              // 7
    '}',                        // 8
    '});',                      // 9
    '  ];',                     // 10
    'x(); /* c */ y();',        // 11
  ].join('\n');
  assert.deepStrictEqual(coverable(src), [2, 5, 7, 11]);
});

test('a // inside a string, a regex or a template is no comment', () => {
  const src = [
    'const u = "http://x"; const v = 1;', // 1
    "const w = 'a // b';",                  // 2
    'const r = /\\/\\//g; z();',            // 3
    'const t = `x // ${y} // z`;',          // 4
  ].join('\n');
  const masked = scan.mask(src);
  assert.ok(masked.split('\n')[0].endsWith('const v = 1;'));
  assert.ok(masked.split('\n')[2].endsWith('z();'));
  assert.deepStrictEqual(coverable(src), [1, 2, 3, 4]);
  // The inside of the literals is masked; the code of ${} is kept.
  assert.ok(!masked.includes('//'));
  assert.ok(masked.split('\n')[3].includes('y'));
});

test('a division is no regex', () => {
  const src = 'const a = b / c; // half\nconst d = (e) / 2 / f;';
  const masked = scan.mask(src);
  assert.strictEqual(masked.split('\n')[0], 'const a = b / c;        ');
  assert.strictEqual(masked.split('\n')[1], 'const d = (e) / 2 / f;');
});

test('a template literal spanning lines: its middle lines are not code', () => {
  const src = [
    'const q = `',   // 1
    '  SELECT *',    // 2
    '  FROM t',      // 3
    '`;',            // 4
    'run(q);',       // 5
  ].join('\n');
  assert.deepStrictEqual(coverable(src), [1, 4, 5]);
});

test('nested templates and ${} with braces', () => {
  const src = 'const s = `a ${ {x: 1}.x } b ${`in ${n}`} c`;\nnext();';
  const masked = scan.mask(src);
  assert.strictEqual(masked.split('\n')[1], 'next();');
  assert.deepStrictEqual(coverable(src), [1, 2]);
});

test('a hashbang line and a BOM', () => {
  assert.deepStrictEqual(coverable('#!/usr/bin/env node\nmain();'), [2]);
  const r = scan.read('\ufeffmain();');
  assert.strictEqual(r.lines[0].first, 1);
});

test('functions: declarations, methods, arrows and their names', () => {
  const src = [
    'function plain(a) {',                          // 1
    '  return a;',                                  // 2
    '}',                                            // 3
    'async function later() {',                     // 4
    '  await x;',                                   // 5
    '}',                                            // 6
    'const arrow = async (a, b) => {',              // 7
    '  return a + b;',                              // 8
    '};',                                           // 9
    'class Cart {',                                 // 10
    '  add(item) {',                                // 11
    '    if (item) {',                              // 12
    '      this.items.push(item);',                 // 13
    '    }',                                        // 14
    '  }',                                          // 15
    '  get count() {',                              // 16
    '    return 1;',                                // 17
    '  }',                                          // 18
    '}',                                            // 19
    'app.get("/x", (req, res) => {',                // 20
    '  res.end();',                                 // 21
    '});',                                          // 22
    'const obj = { key: function () { return 1; }, m() { return 2; } };', // 23
    'for (const a of b) {',                         // 24
    '  go(a);',                                     // 25
    '}',                                            // 26
    'const one = x => {',                           // 27
    '  return x;',                                  // 28
    '};',                                           // 29
  ].join('\n');
  const r = scan.read(src);
  const got = r.functions.map((f) => [f.name, scan.lineOf(r.lines, f.start), scan.lineOf(r.lines, f.end)]);
  assert.deepStrictEqual(got, [
    ['plain', 1, 3],
    ['later', 4, 6],
    ['arrow', 7, 9],
    ['add', 11, 15],
    ['count', 16, 18],
    ['<anonymous>', 20, 22],
    ['key', 23, 23],
    ['m', 23, 23],
    ['one', 27, 29],
  ]);
});

test('functions: TypeScript annotations, generics and return types', () => {
  const src = [
    'export function total(items: Item[]): number {',          // 1
    '  return 0;',                                              // 2
    '}',                                                        // 3
    'export const discount = (c: number, p: number): number => {', // 4
    '  return c;',                                              // 5
    '};',                                                       // 6
    'class A {',                                                // 7
    '  async get<T>(id: string): Promise<T> {',                 // 8
    '    return x;',                                            // 9
    '  }',                                                      // 10
    '  m(a: { x: number }) {',                                  // 11
    '    return a;',                                            // 12
    '  }',                                                      // 13
    '}',                                                        // 14
    'const h: Handler = (req) => {',                            // 15
    '  ok();',                                                  // 16
    '};',                                                       // 17
    'interface I { m(): void; }',                               // 18
  ].join('\n');
  const r = scan.read(src);
  const got = r.functions.map((f) => [f.name, scan.lineOf(r.lines, f.start)]);
  assert.deepStrictEqual(got, [['total', 1], ['discount', 4], ['get', 8], ['m', 11], ['h', 15]]);
});

test('control blocks are no functions', () => {
  const src = 'if (a) {\n}\nwhile (b) {\n}\nswitch (c) {\n}\ntry {\n} catch (e) {\n}\nelse if (d) {\n}';
  assert.deepStrictEqual(scan.read(src).functions, []);
});

test('a line that exports starts at what it exports', () => {
  const src = 'export function f() {\n}\nexport default class A {\n}\nexport const x = 1;\nexport {\n  x,\n};';
  const r = scan.read(src);
  const at = (i) => src.slice(r.lines[i].first, r.lines[i].first + 8);
  assert.strictEqual(at(0), 'function');
  assert.strictEqual(at(2), 'class A ');
  assert.strictEqual(at(4), 'const x ');
  assert.strictEqual(r.lines[5].first, r.lines[5].start, 'export {: the export itself');
  assert.deepStrictEqual(r.functions.map((f) => [f.name, f.start]), [['f', 0]]);
});

test('an object return type is no body', () => {
  const src = [
    'export function cartTotal(skus: string[]): { total: number; missing: string[] } {', // 1
    '  let total = 0;',                                                                  // 2
    '  return { total, missing: [] };',                                                  // 3
    '}',                                                                                 // 4
    'const pair = (a: number): { a: number } => {',                                      // 5
    '  return { a };',                                                                   // 6
    '};',                                                                                // 7
    'const o = { key: { a: 1 } };',                                                      // 8
  ].join('\n');
  const r = scan.read(src);
  const got = r.functions.map((f) => [f.name, scan.lineOf(r.lines, f.start), scan.lineOf(r.lines, f.end)]);
  assert.deepStrictEqual(got, [['cartTotal', 1, 4], ['pair', 5, 7]]);
});
