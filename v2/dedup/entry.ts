// One dedupData.yaml entry as YAML text: the bytes js-yaml 4's dump() gave
// it as an item of the file's list, so that the middleware appends the new
// entry to the file instead of reading, parsing and rewriting the whole file
// on every request. Our own code: no YAML package is needed.
// Limits, each written another way that every YAML 1.1 and 1.2 reader
// (js-yaml 3 and 4 among them) reads back as the same value:
// - a name that starts like a number (a sign, then a digit, or a dot and a
//   digit), or with a dot and an underscore (js-yaml 3 reads `._1` as 0.1),
//   or is ~, null, <<, .inf, .nan or a YAML 1.1 or 1.2 boolean, in any
//   letter case, is single-quoted where js-yaml 4 may leave it plain;
// - an id with a line break, which js-yaml 4 writes as a block, is
//   double-quoted, and one over 76 characters, which it folds, stays on one
//   line;
// - a line that is not a number (no coverage tool gives one) is JSON.

const ESCAPES: { [c: number]: string } = {
  0x00: '\\0', 0x07: '\\a', 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r',
  0x1b: '\\e', 0x22: '\\"', 0x5c: '\\\\', 0x85: '\\N', 0xa0: '\\_', 0x2028: '\\L', 0x2029: '\\P',
};
// js-yaml 4 single-quotes these, for YAML 1.1 readers, at any length.
const BASE60 = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
// Every text a YAML 1.1 or 1.2 reader takes for a null, boolean, number,
// timestamp or merge key matches this, in js-yaml 3 and 4 too. js-yaml 3's
// float takes a dot then digits or underscores, so it reads plain `._1` as
// 0.1 and `._e0` as NaN: a name that starts with `._` is quoted.
const NOT_A_STRING = /^(?:~|null|true|false|y|yes|n|no|on|off|<<|[-+]?\.(?:inf|nan))$|^\._|^[-+]?\.?[0-9]/i;
// The characters a plain scalar may not start with: space and YAML's indicators.
const NOT_FIRST = ' -?:,[]{}#&*!|=>\'"%@`';

// A character js-yaml 4 writes as itself.
function printable(c: number): boolean {
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xd7ff && c !== 0x2028 && c !== 0x2029) ||
    (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff) || c >= 0x10000;
}

function escape(c: number): string {
  if (ESCAPES[c] !== undefined) return ESCAPES[c];
  if (printable(c)) return String.fromCodePoint(c);
  // Every character over U+FFFF is printable, so four digits are enough.
  return c <= 0xff ? '\\x' + ('0' + c.toString(16).toUpperCase()).slice(-2) : '\\u' + ('000' + c.toString(16).toUpperCase()).slice(-4);
}

// s as a scalar, on one line.
export function scalar(s: string): string {
  if (s === '') return "''";
  if (BASE60.test(s)) return "'" + s + "'";
  const chars = Array.from(s, (ch) => ch.codePointAt(0) as number);
  if (!chars.every(printable)) {
    return '"' + chars.map(escape).join('') + '"';
  }
  const plain = !NOT_FIRST.includes(s[0]) && !/[ :]$/.test(s) && !/: | #/.test(s) && !NOT_A_STRING.test(s);
  return plain ? s : "'" + s.replace(/'/g, "''") + "'";
}

// n as js-yaml 4 writes a number.
export function number(n: number): string {
  if (Number.isNaN(n)) return '.nan';
  if (n === Infinity) return '.inf';
  if (n === -Infinity) return '-.inf';
  if (Object.is(n, -0)) return '-0.0';
  const s = String(n);
  return n % 1 !== 0 && /^[-+]?[0-9]+e/.test(s) ? s.replace('e', '.e') : s;
}

// The entry for one request, ending in a line break.
export function entryYaml(id: string, executedLinesByFile: { [filename: string]: unknown[] }): string {
  let out = '- id: ' + scalar(id) + '\n  executedLinesByFile:';
  const files = Object.keys(executedLinesByFile);
  if (files.length === 0) return out + ' {}\n';
  for (const file of files) {
    const key = scalar(file);
    const items = executedLinesByFile[file].map((n) => '- ' + (typeof n === 'number' ? number(n) : JSON.stringify(n) ?? 'null'));
    // A key over 1024 characters is written explicit (? key, then : value),
    // as YAML allows no longer implicit key.
    if (key.length > 1024) out += '\n    ? ' + key + '\n    : ' + (items.length ? items.join('\n      ') : '[]');
    else out += '\n    ' + key + ':' + (items.length ? '\n      ' + items.join('\n      ') : ' []');
  }
  return out + '\n';
}
