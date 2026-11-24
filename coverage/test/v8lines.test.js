'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hitEntries } = require('../lib/v8lines');

test('the innermost range holding an offset decides', () => {
  // A script [0,100) run once; f [10,50) called; a block in f [20,30) not
  // run; g [60,90) not called; a block of the script after g [90,100) run.
  const functions = [
    { ranges: [{ startOffset: 0, endOffset: 100, count: 0 }] },
    { ranges: [{ startOffset: 10, endOffset: 50, count: 2 }, { startOffset: 20, endOffset: 30, count: 0 }] },
    { ranges: [{ startOffset: 60, endOffset: 90, count: 0 }] },
  ];
  const offs = [0, 5, 10, 15, 20, 29, 30, 49, 50, 60, 89, 95];
  const hit = hitEntries(functions, offs).map((i) => offs[i]);
  assert.deepStrictEqual(hit, [10, 15, 30, 49]);
});

test('a block range of the same span as its function comes after it', () => {
  const functions = [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 0, endOffset: 10, count: 0 }] }];
  assert.deepStrictEqual(hitEntries(functions, [3]), []);
});

test('an offset in no range is not hit', () => {
  const functions = [{ ranges: [{ startOffset: 10, endOffset: 20, count: 5 }] }];
  assert.deepStrictEqual(hitEntries(functions, Int32Array.from([5, 25])), []);
});

test('sibling ranges after a nested one', () => {
  const functions = [
    { ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
    { ranges: [{ startOffset: 10, endOffset: 20, count: 0 }] },
    { ranges: [{ startOffset: 30, endOffset: 40, count: 0 }] },
  ];
  const offs = [5, 15, 25, 35, 45];
  const hit = hitEntries(functions, offs).map((i) => offs[i]);
  assert.deepStrictEqual(hit, [5, 25, 45]);
});
