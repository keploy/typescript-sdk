'use strict';
// The build table of a Node app: one unit per source file under the app's
// root, each coverable line one leaf of exactly one method, in the shape
// and order of keploy's code coverage contract (schema 1), plus what turns
// V8's per-script counts into those lines (gen).
//
// Nothing is measured silently wrong: a script whose lines cannot be told
// (a minified file with no map, a map whose sources are all outside the
// root, an unreadable file) is a not_measured unit with its reason, and a
// map whose sources are missing or stale measures the generated file itself.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scan = require('./scan');
const sourcemap = require('./sourcemap');

// TABLE_FORMAT versions the way lines and methods are read; the build id
// also names the adapter's version, so a new adapter is a new build.
const TABLE_FORMAT = 2;
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 4 << 20;
// A line this long in a file with no source map is minified code: one
// line holds many statements, which per-line coverage cannot tell apart.
const MINIFIED_LINE = 2000;
const SCRIPT_EXT = new Set(['.js', '.cjs', '.mjs']);
// What a script V8 runs under the root may be, for it to be app code the
// table lacks: a template engine's sourceURL (views/x.ejs) never is.
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '__tests__']);
// keploy's Go side refuses a whole table whose unit path holds a backslash
// or a control character, or a leaf past this line: such files and lines
// are left out (and said), never sent.
const MAX_LINE = 1 << 20;
const BAD_NAME = /[\\\u0000-\u001f\u007f]/;

/**
 * globRe(glob) -> RegExp over a root-relative slash path: * is any run of
 * characters but /, ** any run (slashes too), ? one character but /.
 */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/**
 * excluder(env) -> (rel) => true when the root-relative path rel is no app
 * code: a test file (*.test.*, *.spec.*), a tool's config at the root
 * (jest.config.js), a minified *.min.js, or one KEPLOY_COVERAGE_EXCLUDE
 * (comma-separated globs) names. A glob with no / matches the base name too.
 */
function excluder(env) {
  const globs = (env.KEPLOY_COVERAGE_EXCLUDE || '').split(',').map((g) => g.trim()).filter(Boolean);
  const res = globs.map((g) => ({ re: globRe(g), base: !g.includes('/') }));
  return (rel) => {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (/\.(test|spec)\.[^.]+$/.test(base) || /\.min\.js$/.test(base)) return true;
    if (!rel.includes('/') && /\.config\.[^.]+$/.test(base)) return true;
    return res.some(({ re, base: b }) => re.test(rel) || (b && re.test(base)));
  };
}

/**
 * walk(root, excluded) -> sorted root-relative slash paths of the scripts
 * under root: .js, .cjs, .mjs, skipping node_modules, __tests__, hidden
 * dirs, the root's own coverage/ (a report dir) and excluded paths.
 * Symlinks are not followed.
 */
function walk(root, excluded, notes = []) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (BAD_NAME.test(e.name)) {
        notes.push(`${JSON.stringify(r)} is left out: its name holds a backslash or a control character`);
        continue;
      }
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && r !== 'coverage') stack.push(r);
      } else if (e.isFile() && SCRIPT_EXT.has(path.extname(e.name)) && !excluded(r)) {
        out.push(r);
        if (out.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} scripts under ${root}`);
      }
    }
  }
  return out.sort();
}

// inside(root, abs) -> root-relative slash path of abs, or null when abs is
// not under root (or names a hidden or node_modules path there).
function inside(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules' || BAD_NAME.test(p))) return null;
  return parts.join('/');
}

// skipped(rel): a root-relative path the walk never measures by place
// (node_modules, __tests__, a hidden dir, the root's coverage/).
function skippedPath(rel) {
  const parts = rel.split('/');
  return parts[0] === 'coverage' || parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p));
}

function sha256(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

// compareBytes: Go's string order (bytes of UTF-8).
function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// comparePkg: keploy's package order (codecoverage.comparePkg): segment by
// segment, so a dir and everything under it are one run.
function comparePkg(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  for (let i = 0; i < x.length && i < y.length; i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === 0x2f) return -1;
    if (y[i] === 0x2f) return 1;
    return x[i] - y[i];
  }
  return x.length - y.length;
}

/**
 * methodsOf(unitPath, src, coverable) -> the unit's methods: each line of
 * coverable (a Set of 1-based lines) goes to the innermost function whose
 * span holds the line's first code character, or to <module>. One sweep:
 * functions come sorted by start (outer first), and nest.
 */
function methodsOf(unitPath, src, coverable) {
  const r = scan.read(src);
  const fns = r.functions;
  const byID = new Map();
  const add = (name, line, leafLine) => {
    const id = `m:${unitPath}#${name}@${line}`;
    let m = byID.get(id);
    if (!m) {
      m = { id, name, line, lines: [] };
      byID.set(id, m);
    }
    m.lines.push(leafLine);
  };
  const lines = [...coverable].sort((a, b) => a - b);
  const stack = [];
  let fi = 0;
  for (const L of lines) {
    const info = r.lines[L - 1];
    const off = info ? (info.first >= 0 ? info.first : info.start) : Infinity;
    while (fi < fns.length && fns[fi].start <= off) {
      const f = fns[fi++];
      while (stack.length && stack[stack.length - 1].end < f.start) stack.pop();
      stack.push(f);
    }
    while (stack.length && stack[stack.length - 1].end < off) stack.pop();
    const f = stack.length ? stack[stack.length - 1] : null;
    if (f && f.start <= off && off <= f.end) add(f.name, scan.lineOf(r.lines, f.start), L);
    else add('<module>', 1, L);
  }
  const methods = [...byID.values()].map((m) => ({
    id: m.id,
    name: m.name,
    line: m.line,
    leaves: m.lines.map((l) => [l, 0, l, 0, 1, 0]),
  }));
  methods.sort((a, b) => a.line - b.line || compareBytes(a.id, b.id));
  return methods;
}

function unitOf(rel, hash, methods, failed) {
  const slash = rel.lastIndexOf('/');
  const u = {
    kind: 'file',
    id: 'f:' + rel,
    pkg: slash < 0 ? '' : rel.slice(0, slash),
    name: rel.slice(slash + 1),
    path: rel,
    hash,
    state: failed ? 'not_measured' : 'ok',
  };
  if (failed) u.reason = { code: 'analyzer_failed' };
  u.methods = failed ? [] : methods;
  return u;
}

// encode: one unit as keploy's Go side encodes it (encoding/json with
// SetEscapeHTML(false)): JSON.stringify writes the same bytes but for
// U+2028 and U+2029, which Go escapes.
function encode(u) {
  return JSON.stringify(u).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n';
}

function readCapped(abs) {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_FILE_BYTES) throw new Error(`${st.size} bytes, more than ${MAX_FILE_BYTES}`);
  return { bytes: fs.readFileSync(abs) };
}

function lineStarts(text) {
  const out = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

/**
 * analyzeScript(root, rel, excluded) -> what one script under the root
 * gives the table:
 *   {rel, abs, text (BOM cut, as V8 runs it), mapSha, flag,
 *    failed: why | null (the script is a not_measured unit of its own),
 *    entries: [{off, unit, line}] sorted by off (V8's offsets),
 *    units: Map<rel, {hash, text, coverable: Set}>,
 *    notes: [why] (sources left out)}
 */
function analyzeScript(root, rel, excluded) {
  const abs = path.join(root, rel);
  const out = { rel, abs, text: '', mapSha: '', flag: 'plain', failed: null, entries: [], units: new Map(), notes: [], hash: '' };
  let read;
  try {
    read = readCapped(abs);
  } catch (e) {
    out.failed = `it cannot be read: ${e.message}`;
    return out;
  }
  out.hash = sha256(read.bytes);
  let text = read.bytes.toString('utf8');
  // Node runs a script with its BOM cut: V8's offsets are those of the rest.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  out.text = text;
  let map = null;
  try {
    map = sourcemap.load(abs, text, root);
  } catch (e) {
    out.failed = `its source map cannot be read: ${e.message}`;
    return out;
  }
  const plain = () => {
    const r = scan.read(text);
    const unit = { hash: out.hash, text, coverable: new Set() };
    r.lines.forEach((info, i) => {
      if (info.first < 0 || i + 1 > MAX_LINE) return;
      unit.coverable.add(i + 1);
      out.entries.push({ off: info.first, unit: rel, line: i + 1 });
    });
    out.units.set(rel, unit);
  };
  if (!map) {
    let longest = 0;
    for (let s = 0, e = text.indexOf('\n'); s <= text.length; s = e + 1, e = text.indexOf('\n', s)) {
      const end = e < 0 ? text.length : e;
      longest = Math.max(longest, end - s);
      if (e < 0) break;
    }
    if (longest > MINIFIED_LINE) {
      out.failed = `it is minified (a line of ${longest} characters) and has no source map`;
      out.flag = 'minified';
      return out;
    }
    plain();
    return out;
  }
  out.mapSha = map.sha;
  // The map's sources: which are the app's files, and their text.
  const srcs = map.sources.map((abs2, i) => {
    const srel = abs2 ? inside(root, abs2) : null;
    if (!srel || excluded(srel)) return { srel: null, why: map.raw[i] };
    let disk = null;
    try {
      disk = readCapped(abs2).bytes;
    } catch {
      // not on disk: the map's sourcesContent, if it has one
    }
    const content = map.contents[i];
    if (disk === null && content === null) return { srel, missing: true };
    if (disk !== null && content !== null && content !== disk.toString('utf8')) return { srel, stale: 'its sourcesContent differs from the file' };
    const bytes = disk !== null ? disk : Buffer.from(content, 'utf8');
    return { srel, bytes, text: bytes.toString('utf8') };
  });
  // A map with no sourcesContent is checked by its positions: one that
  // points past a source's end, or past the end of a line, is stale (the
  // source changed after the build). Only the bytes decide, never mtimes,
  // so one build always has one table.
  const lens = srcs.map((s, i) => (s.text && map.contents[i] === null ? s.text.split('\n').map((l) => l.length) : null));
  const past = new Set();
  for (const segs of map.lines) {
    for (const [, src, sl, sc] of segs) {
      const L = src >= 0 ? lens[src] : null;
      if (L && (sl >= L.length || sc > L[sl])) past.add(src);
    }
  }
  for (const i of past) srcs[i] = { srel: srcs[i].srel, stale: 'it maps to places past the source\'s end (the source changed after the build)' };
  const usable = srcs.filter((s) => s.srel && s.text !== undefined);
  for (const s of srcs) if (!s.srel) out.notes.push(`${rel}: its map's source ${s.why} is not a file of the app`);
  const missing = srcs.filter((s) => s.missing);
  const stale = srcs.filter((s) => s.stale);
  if (missing.length || stale.length) {
    // The generated file is what runs: measure it, not a source it no
    // longer matches or that is not here.
    out.flag = 'unmapped';
    out.notes.push(missing.length
      ? `${rel}: measured as itself: its map's source ${missing[0].srel} is not on disk and the map has no sourcesContent`
      : `${rel}: measured as itself: its map is stale for ${stale[0].srel} (${stale[0].stale})`);
    plain();
    return out;
  }
  if (!usable.length) {
    out.failed = 'its source map names no file of the app (all its sources are outside the root, or no files)';
    out.flag = 'outside';
    return out;
  }
  out.flag = 'mapped';
  // Entries from the mapping segments: each segment that maps to a code
  // line of an app source is one entry, at its generated offset; a line ran
  // when any of its segments ran.
  const scans = new Map();
  const starts = lineStarts(text);
  srcs.forEach((s, i) => {
    if (s.text === undefined || !s.srel) return;
    scans.set(i, scan.read(s.text).lines);
    if (!out.units.has(s.srel)) out.units.set(s.srel, { hash: sha256(s.bytes), text: s.text, coverable: new Set() });
  });
  const seen = new Set();
  map.lines.forEach((segs, g) => {
    if (g >= starts.length) return;
    const lineEnd = g + 1 < starts.length ? starts[g + 1] - 1 : text.length;
    for (const [col, src, sl] of segs) {
      const lines = scans.get(src);
      if (!lines) continue;
      const info = lines[sl];
      if (!info || info.first < 0 || sl + 1 > MAX_LINE) continue;
      const off = starts[g] + col;
      if (off > lineEnd) continue;
      const key = `${off}:${src}:${sl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = srcs[src];
      out.units.get(s.srel).coverable.add(sl + 1);
      out.entries.push({ off, unit: s.srel, line: sl + 1 });
    }
  });
  out.entries.sort((a, b) => a.off - b.off);
  return out;
}

/**
 * compact(entries, unitIndex) -> {offs, lines, units}: typed arrays, sorted
 * by offset, units as indices into the table's unit names.
 */
function compact(entries, unitIndex) {
  const n = entries.length;
  const offs = new Int32Array(n);
  const lines = new Int32Array(n);
  const units = new Int32Array(n);
  entries.forEach((e, i) => {
    offs[i] = e.off;
    lines[i] = e.line;
    units[i] = unitIndex.get(e.unit);
  });
  return { offs, lines, units };
}

/**
 * build(rootIn, env, runtime, sdk, pause) -> Promise of {
 *   root, build, ndjson (Buffer), unitCount,
 *   names: the unit paths (gen's unit indices name them),
 *   gen: Map<abs script path, {offs, lines, units, textLen, textSha, unitNames}>,
 *   failed: [{path, why}], notes: [why],
 * }. runtime is "node <major>.<minor>", sdk the adapter's version; pause()
 * is awaited between files, so the app's event loop runs on.
 */
async function build(rootIn, env, runtime, sdk, pause, opts = {}) {
  const root = fs.realpathSync(rootIn);
  const excluded = excluder(env);
  const held = opts.held || new Set();
  const notes = [];
  const scripts = walk(root, excluded, notes);
  // The main script is the app's whatever its name (bin/www has none).
  const mainRel = opts.main ? inside(root, opts.main) : null;
  if (mainRel && !scripts.includes(mainRel) && !excluded(mainRel) && !skippedPath(mainRel)) {
    scripts.push(mainRel);
    scripts.sort();
  }
  // known: every root path the table read, measured or not: a script V8
  // runs that is none of them is one the table does not hold.
  const known = new Set(scripts);
  const units = new Map(); // rel -> {hash, text, coverable, failed}
  const failed = [];
  const analyzed = [];
  const ids = [];
  for (const rel of scripts) {
    if (pause) await pause();
    if (held.has(path.join(root, rel))) {
      // Compiled before keploy's preload started V8's precise coverage: it
      // has no block counts, so its lines cannot be told.
      const why = 'it was loaded before keploy\'s coverage preload (another --require came first): put keploy\'s --require first';
      let hash = sha256(Buffer.alloc(0));
      try { hash = sha256(readCapped(path.join(root, rel)).bytes); } catch { /* unreadable */ }
      ids.push(`g\u0000${rel}\u0000${hash}\u0000\u0000held`);
      failed.push({ path: rel, why });
      units.set(rel, { hash, failed: why });
      continue;
    }
    const a = analyzeScript(root, rel, excluded);
    notes.push(...a.notes);
    ids.push(`g\u0000${rel}\u0000${a.hash}\u0000${a.mapSha}\u0000${a.flag}`);
    if (a.failed) {
      failed.push({ path: rel, why: a.failed });
      units.set(rel, { hash: a.hash || sha256(Buffer.alloc(0)), failed: a.failed });
      continue;
    }
    for (const [srel, u] of a.units) {
      known.add(srel);
      const have = units.get(srel);
      if (!have) {
        units.set(srel, { hash: u.hash, text: u.text, coverable: new Set(u.coverable) });
      } else if (!have.failed && have.hash !== u.hash) {
        // The bytes that name the build are the bytes the lines come from:
        // a file read as two texts (it changed while the table was read, or
        // two maps carry two contents for it) is not measured.
        have.failed = `it was read as two different texts (sha256 ${have.hash.slice(0, 12)} and ${u.hash.slice(0, 12)}): it changed while the table was read, or two maps carry two contents for it`;
        failed.push({ path: srel, why: have.failed });
      } else if (!have.failed) {
        for (const l of u.coverable) have.coverable.add(l);
      }
    }
    analyzed.push(a);
  }
  const records = [];
  for (const [rel, u] of units) {
    if (pause) await pause();
    if (u.failed) {
      records.push(unitOf(rel, u.hash, [], true));
      continue;
    }
    if (u.coverable.size === 0) continue;
    let methods;
    try {
      methods = methodsOf(rel, u.text, u.coverable);
    } catch (e) {
      failed.push({ path: rel, why: e.message });
      records.push(unitOf(rel, u.hash, [], true));
      continue;
    }
    records.push(unitOf(rel, u.hash, methods, false));
  }
  records.sort((a, b) => comparePkg(a.pkg, b.pkg) || compareBytes(a.id, b.id));
  const names = records.filter((u) => u.state === 'ok').map((u) => u.path);
  const index = new Map(names.map((n, i) => [n, i]));
  const gen = new Map();
  for (const a of analyzed) {
    // A failed unit's lines are none: entries for it are left out.
    const entries = a.entries.filter((e) => index.has(e.unit));
    if (!entries.length) continue;
    gen.set(a.abs, {
      ...compact(entries, index),
      textLen: a.text.length,
      textSha: sha256(a.text),
      unitNames: [...new Set(entries.map((e) => e.unit))].sort(),
    });
  }
  for (const u of records) ids.push(`u\u0000${u.path}\u0000${u.hash}`);
  ids.sort(compareBytes);
  const head = `keploy-node-table ${TABLE_FORMAT}\n${runtime}\n@keploy/coverage ${sdk}\n`;
  const buildID = 'js1-' + sha256(head + ids.join('\n')).slice(0, 32);
  const ndjson = Buffer.from(records.map(encode).join(''), 'utf8');
  // appScript(abs) -> the root-relative path of a script V8 ran that is app
  // code the table does not hold, or null.
  const appScript = (abs) => {
    const rel = inside(root, abs);
    if (!rel || known.has(rel) || excluded(rel) || skippedPath(rel)) return null;
    if (!CODE_EXT.has(path.extname(rel)) && rel !== mainRel) return null;
    return rel;
  };
  // dead: the scripts whose lines, or some of them, count for a unit the
  // table holds not measured (held preloads aside): a test that ran one is
  // named in classMismatch, never sent as whole.
  const notMeasured = new Set(records.filter((u) => u.state !== 'ok').map((u) => u.path));
  const dead = new Map();
  for (const rel of scripts) {
    const abs = path.join(root, rel);
    if (held.has(abs)) continue;
    if (notMeasured.has(rel)) dead.set(abs, [rel]);
  }
  for (const a of analyzed) {
    const d = [...a.units.keys()].filter((u) => notMeasured.has(u));
    if (d.length) dead.set(a.abs, [...new Set([...(dead.get(a.abs) || []), ...d])].sort());
  }
  return { root, build: buildID, ndjson, unitCount: records.length, names, gen, failed, notes, appScript, dead };
}

module.exports = {
  build, walk, excluder, skippedPath, globRe, methodsOf, comparePkg, encode, analyzeScript, sha256,
  TABLE_FORMAT, MINIFIED_LINE, MAX_FILE_BYTES,
};
