'use strict';
// A small, deterministic reading of a JavaScript or TypeScript source, with
// no parser: which lines hold code, where each line's code starts, and where
// the source's functions are. It is what the build table is made of, so it
// must give the same answer for the same bytes every time.
//
// mask() returns the source with every comment turned into spaces and the
// inside of every string, template and regular expression literal turned
// into LIT (newlines kept, so offsets and line numbers stay the same). The
// quotes themselves, and the code of a template's ${...}, are kept.

const LIT = '\u0001';
// Characters that alone never make a line code: brackets and separators.
const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ';', ',']);
// A '/' after one of these words starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);
// Words that open a block with a parenthesis but no function.
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'await', 'yield', 'new', 'delete', 'void', 'in', 'of']);

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' ||
    c === '\u00a0' || c === '\ufeff' || c === '\u2028' || c === '\u2029';
}

function isIdent(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c === '_' || c === '$' || c > '\u007f';
}

/**
 * mask(src) -> string of src's length; see the file comment.
 * @param {string} src
 */
function mask(src) {
  const n = src.length;
  const out = src.split('');
  let i = 0;
  // prev: the last significant token, for telling a regex from a division:
  // '' (none yet), a punctuator, 'w:<word>', 'num', 'lit' or ')' / ']'.
  let prev = '';
  // tmpl: for each template whose ${ is open, the brace depth it opened at.
  const tmpl = [];
  let depth = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const lit = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = LIT;
  };
  // A hashbang line is a comment.
  if (src.startsWith('#!')) {
    let e = src.indexOf('\n');
    if (e < 0) e = n;
    blank(0, e);
    i = e;
  }
  // readTemplate reads template text from i (just after ` or a closing })
  // to its end or to the next ${, and returns where code goes on.
  const readTemplate = (from) => {
    let k = from;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '`') { lit(from, k); prev = 'lit'; return k + 1; }
      if (c === '$' && src[k + 1] === '{') {
        lit(from, k + 2);
        tmpl.push(depth);
        depth++;
        prev = '{';
        return k + 2;
      }
      k++;
    }
    lit(from, n);
    return n;
  };
  while (i < n) {
    const c = src[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      let e = src.indexOf('\n', i);
      if (e < 0) e = n;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let e = src.indexOf('*/', i + 2);
      e = e < 0 ? n : e + 2;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === '\'' || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') {
        if (src[k] === '\\') k++;
        k++;
      }
      lit(i + 1, Math.min(k, n));
      i = k < n && src[k] === c ? k + 1 : k;
      prev = 'lit';
      continue;
    }
    if (c === '`') {
      i = readTemplate(i + 1);
      continue;
    }
    if (c === '/') {
      const regex = prev === '' || (prev.length === 1 && prev !== ')' && prev !== ']') ||
        (prev.startsWith('w:') && REGEX_AFTER_WORD.has(prev.slice(2)));
      if (regex) {
        let k = i + 1;
        let cls = false;
        while (k < n && src[k] !== '\n') {
          const d = src[k];
          if (d === '\\') { k += 2; continue; }
          if (d === '[') cls = true;
          else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          k++;
        }
        lit(i + 1, Math.min(k, n));
        i = k < n && src[k] === '/' ? k + 1 : k;
        while (i < n && isIdent(src[i])) i++; // flags
        prev = 'lit';
        continue;
      }
      prev = '/';
      i++;
      continue;
    }
    if (isIdent(c)) {
      let k = i + 1;
      while (k < n && isIdent(src[k])) k++;
      const word = src.slice(i, k);
      prev = c >= '0' && c <= '9' ? 'num' : 'w:' + word;
      i = k;
      continue;
    }
    if (c === '{') { depth++; prev = '{'; i++; continue; }
    if (c === '}') {
      if (tmpl.length && tmpl[tmpl.length - 1] === depth - 1) {
        // The } that closes a template's ${: template text goes on.
        tmpl.pop();
        depth--;
        out[i] = LIT;
        i = readTemplate(i + 1);
        continue;
      }
      depth = Math.max(0, depth - 1);
      prev = '}';
      i++;
      continue;
    }
    prev = c;
    i++;
  }
  return out.join('');
}

/**
 * lines(masked) -> one entry per line (index 0 is line 1): {start, first},
 * start the line's offset and first the offset of its first character that
 * is code (not space, not a bracket or separator), or -1 when the line holds
 * none: a line with first >= 0 is coverable. The inside of a literal is not
 * code there (a template's second line is not a statement), its quotes are.
 * @param {string} masked
 */
function lines(masked) {
  const out = [];
  let start = 0;
  const n = masked.length;
  while (start <= n) {
    let end = masked.indexOf('\n', start);
    if (end < 0) end = n;
    let first = -1;
    for (let k = start; k < end; k++) {
      const c = masked[k];
      if (isSpace(c) || c === LIT || PUNCT.has(c)) continue;
      first = k;
      break;
    }
    // "export" and "export default" run nothing: the line's code starts at
    // what they export (V8 counts "export function f" with f).
    if (first >= 0) first = skipExport(masked, first, end);
    out.push({ start, first });
    if (end === n) break;
    start = end + 1;
  }
  return out;
}

function skipExport(s, k, end) {
  for (const word of ['export', 'default']) {
    if (s.startsWith(word, k) && k + word.length < end && isSpace(s[k + word.length])) {
      let j = k + word.length;
      while (j < end && isSpace(s[j])) j++;
      // Only a declaration ("export function", "export default class"):
      // "export {" and "export *" stay as they are.
      if (j >= end || !isIdent(s[j])) return k;
      k = j;
    } else if (word === 'export') {
      return k;
    }
  }
  return k;
}

// pairs(masked) -> {close: Map open{ -> close}, open: Map close) -> open(}.
function pairs(masked) {
  const close = new Map();
  const open = new Map();
  const braces = [];
  const parens = [];
  for (let k = 0; k < masked.length; k++) {
    const c = masked[k];
    if (c === '{') braces.push(k);
    else if (c === '}') { if (braces.length) close.set(braces.pop(), k); }
    else if (c === '(') parens.push(k);
    else if (c === ')') { if (parens.length) open.set(k, parens.pop()); }
  }
  return { close, open };
}

function nextNonSpace(s, k) {
  while (k < s.length && isSpace(s[k])) k++;
  return k;
}

function prevNonSpace(s, k) {
  while (k >= 0 && isSpace(s[k])) k--;
  return k;
}

// wordBefore(s, k): the identifier that ends at or before k (spaces
// skipped): {word, start} or null.
function wordBefore(s, k) {
  k = prevNonSpace(s, k);
  if (k < 0 || !isIdent(s[k])) return null;
  let b = k;
  while (b > 0 && isIdent(s[b - 1])) b--;
  return { word: s.slice(b, k + 1), start: b };
}

// skipGenericsBack: k at a '>' closing TypeScript type parameters: the
// offset before its '<', else k.
function skipGenericsBack(s, k) {
  if (s[k] !== '>') return k;
  let d = 0;
  for (let j = k; j >= 0 && k - j < 400; j--) {
    if (s[j] === '>') d++;
    else if (s[j] === '<') { d--; if (d === 0) return prevNonSpace(s, j - 1); }
    else if (s[j] === ';' || s[j] === '{' || s[j] === '}') break;
  }
  return k;
}

// closeParenBefore(s, k, open): the ')' that a body's '{' (or an '=>') at
// k follows, past a TypeScript return type ("): Promise<X> {"), or -1.
function closeParenBefore(s, k, open, braceOpen) {
  const p = prevNonSpace(s, k);
  if (p >= 0 && s[p] === ')') return p;
  // "): Type": scan back over type characters to a ':' right after a ')'.
  // An object type's braces ("): { a: T } {") are passed over whole.
  for (let j = p; j >= 0 && p - j < 400; j--) {
    const c = s[j];
    if (c === '}' && braceOpen && braceOpen.has(j)) { j = braceOpen.get(j); continue; }
    if (c === ';' || c === '{' || c === '}' || c === '(' || (c === '=' && s[j + 1] !== '>')) return -1;
    if (c === ':') {
      const q = prevNonSpace(s, j - 1);
      return q >= 0 && s[q] === ')' && open.has(q) ? q : -1;
    }
  }
  return -1;
}

// boundName(s, k): the name a function starting after k is bound to:
// "name =", "name: Type =", "key:" (a property) or "key(" never; null when none.
function boundName(s, k) {
  let p = prevNonSpace(s, k);
  if (p < 0) return null;
  if (s[p] === '=' && !'=!<>+-*/%&|^?'.includes(s[p - 1] || '') && s[p + 1] !== '=') {
    const w = wordBefore(s, p - 1);
    if (w) {
      // "name: Type =": the name, not its type.
      const q = prevNonSpace(s, w.start - 1);
      const v = q >= 0 && s[q] === ':' ? wordBefore(s, q - 1) : null;
      return v ? v.word : w.word;
    }
    // "name: Type = (": the word before the ':' of the annotation.
    for (let j = p - 1; j >= 0 && p - j < 200; j--) {
      if (s[j] === ';' || s[j] === '{' || s[j] === '}' || s[j] === '\n') break;
      if (s[j] === ':') { const v = wordBefore(s, j - 1); return v ? v.word : null; }
    }
    return null;
  }
  if (s[p] === ':') {
    const q = prevNonSpace(s, p - 1);
    if (q >= 0 && (s[q] === '\'' || s[q] === '"')) return null; // a quoted key
    const w = wordBefore(s, p - 1);
    return w ? w.word : null;
  }
  return null;
}

// Words that may come before a function or method on its line: its start
// is taken back over them, so its first line is the line it begins on.
const MODIFIERS = new Set(['export', 'default', 'async', 'static', 'public', 'private', 'protected',
  'readonly', 'override', 'abstract', 'declare', 'get', 'set']);

function withModifiers(s, start) {
  for (;;) {
    const w = wordBefore(s, start - 1);
    if (!w || !MODIFIERS.has(w.word)) return start;
    start = w.start;
  }
}

/**
 * functions(masked) -> [{name, start, end}]: each function the source
 * defines with a block body, start the offset where it begins (its
 * "function" or "async" keyword, a method's name, an arrow's parameters)
 * and end its closing brace. Expression-bodied arrows are left to the
 * function around them.
 * @param {string} s masked source
 */
function functions(s) {
  const { close, open } = pairs(s);
  const braceOpen = new Map();
  for (const [b, e] of close) braceOpen.set(e, b);
  const out = [];
  for (const [b, e] of close) {
    // An object type right after a return type's ':' ("): { a: T } {" or
    // "): { a: T } =>") is no body: the body, if any, follows it.
    const colon = prevNonSpace(s, b - 1);
    if (colon >= 0 && s[colon] === ':') {
      const after = nextNonSpace(s, e + 1);
      if (after < s.length && (s[after] === '{' || (s[after] === '=' && s[after + 1] === '>'))) continue;
    }
    let p = prevNonSpace(s, b - 1);
    if (p < 1) continue;
    // An arrow's block body.
    if (s[p] === '>' && s[p - 1] === '=') {
      const q = prevNonSpace(s, p - 2);
      let start;
      if (q >= 0 && s[q] === ')' && open.has(q)) {
        start = open.get(q);
      } else {
        const rp = closeParenBefore(s, p - 1, open, braceOpen);
        if (rp >= 0) start = open.get(rp);
        else {
          const w = wordBefore(s, q);
          if (!w) continue;
          start = w.start;
        }
      }
      const g = skipGenericsBack(s, prevNonSpace(s, start - 1));
      let before = g;
      const a = wordBefore(s, before);
      if (a && a.word === 'async') { start = a.start; before = a.start - 1; }
      out.push({ name: boundName(s, before) || '<anonymous>', start, end: e });
      continue;
    }
    const rp = closeParenBefore(s, b - 1, open, braceOpen);
    if (rp < 0) continue;
    const lp = open.get(rp);
    const g = skipGenericsBack(s, prevNonSpace(s, lp - 1));
    const w = wordBefore(s, g);
    if (!w) {
      // "function (" with a '*' generator mark, or a computed name: none.
      const k = prevNonSpace(s, lp - 1);
      if (k >= 0 && s[k] === '*') {
        const f = wordBefore(s, k - 1);
        if (f && f.word === 'function') {
          out.push({ name: boundName(s, f.start - 1) || '<anonymous>', start: f.start, end: e });
        }
      }
      continue;
    }
    if (CONTROL.has(w.word)) continue;
    if (w.word === 'function') {
      let start = w.start;
      const a = wordBefore(s, start - 1);
      if (a && a.word === 'async') start = a.start;
      out.push({ name: boundName(s, start - 1) || '<anonymous>', start, end: e });
      continue;
    }
    // "function name(" or "function* name(".
    let k = prevNonSpace(s, w.start - 1);
    if (k >= 0 && s[k] === '*') k = prevNonSpace(s, k - 1);
    const f = k >= 0 ? wordBefore(s, k) : null;
    if (f && f.word === 'function') {
      out.push({ name: w.word, start: withModifiers(s, f.start), end: e });
      continue;
    }
    // A method: "name(...) {" in a class or an object literal.
    out.push({ name: w.word, start: withModifiers(s, w.start), end: e });
  }
  out.sort((x, y) => x.start - y.start || y.end - x.end);
  return out;
}

/**
 * read(src) -> {masked, lines, functions} of a source, a BOM cut first (a
 * BOM is not part of the code Node runs).
 * @param {string} src
 */
function read(src) {
  if (src.charCodeAt(0) === 0xfeff) src = ' ' + src.slice(1);
  const masked = mask(src);
  return { masked, lines: lines(masked), functions: functions(masked) };
}

/**
 * lineOf(starts, off): the 1-based line of offset off, starts being each
 * line's start offset in order.
 */
function lineOf(lineInfo, off) {
  let lo = 0;
  let hi = lineInfo.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineInfo[mid].start <= off) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

module.exports = { mask, lines, functions, read, lineOf, LIT };
