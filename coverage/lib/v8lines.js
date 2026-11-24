'use strict';
// V8's precise block coverage of one script, read at given offsets: the
// count of the innermost range that holds each offset, as c8 reads it.
// V8's ranges nest (a function's own range first, then its blocks), so one
// sweep with a stack answers every offset.

/**
 * hitEntries(functions, offs) -> the indices i (ascending) of the offsets
 * offs[i] (sorted ascending) whose innermost range has a count above 0.
 * @param {Array<{ranges: Array<{startOffset:number,endOffset:number,count:number}>}>} functions
 * @param {ArrayLike<number>} offs
 */
function hitEntries(functions, offs) {
  const ranges = [];
  let order = 0;
  for (const f of functions) {
    for (const r of f.ranges) ranges.push({ s: r.startOffset, e: r.endOffset, c: r.count, o: order++ });
  }
  // Outer before inner: by start, then the longer first, then V8's order
  // (a function's own range before a block of the same span).
  ranges.sort((a, b) => a.s - b.s || b.e - a.e || a.o - b.o);
  const out = [];
  const stack = [];
  let ri = 0;
  for (let i = 0; i < offs.length; i++) {
    const off = offs[i];
    while (ri < ranges.length && ranges[ri].s <= off) {
      const r = ranges[ri++];
      while (stack.length && stack[stack.length - 1].e <= r.s) stack.pop();
      stack.push(r);
    }
    while (stack.length && stack[stack.length - 1].e <= off) stack.pop();
    // The top may be a range that ended before off under one that holds it
    // (ranges that do not nest): look down for the innermost that holds it.
    for (let k = stack.length - 1; k >= 0; k--) {
      const r = stack[k];
      if (r.s <= off && off < r.e) {
        if (r.c > 0) out.push(i);
        break;
      }
    }
  }
  return out;
}

module.exports = { hitEntries };
