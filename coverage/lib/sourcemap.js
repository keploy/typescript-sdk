'use strict';
// Source map v3, read with no dependency: the mappings decoded into one
// sorted segment list per generated line, index maps (sections) included,
// and each source resolved to a file path (file paths, file: URLs and
// webpack:// URLs, which name files under the app's root).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64V = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64V[B64.charCodeAt(i)] = i;

/**
 * decodeMappings(str) -> lines: lines[g] is generated line g's (0-based)
 * segments, each [genCol, src, srcLine, srcCol] (0-based; src -1 for a
 * segment that maps to no source), sorted by genCol.
 * @param {string} str
 */
function decodeMappings(str) {
  const lines = [[]];
  let genCol = 0;
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let seg = [];
  let value = 0;
  let shift = 0;
  const flush = () => {
    if (seg.length === 0) return;
    if (seg.length !== 1 && seg.length !== 4 && seg.length !== 5) {
      throw new Error(`a mapping segment of ${seg.length} fields`);
    }
    genCol += seg[0];
    const line = lines[lines.length - 1];
    if (seg.length === 1) {
      line.push([genCol, -1, 0, 0]);
    } else {
      src += seg[1];
      srcLine += seg[2];
      srcCol += seg[3];
      if (src < 0 || srcLine < 0 || srcCol < 0 || genCol < 0) throw new Error('a negative mapping');
      line.push([genCol, src, srcLine, srcCol]);
    }
    seg = [];
  };
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 44 /* , */) { if (shift) throw new Error('a cut VLQ'); flush(); continue; }
    if (c === 59 /* ; */) {
      if (shift) throw new Error('a cut VLQ');
      flush();
      lines.push([]);
      genCol = 0;
      continue;
    }
    const d = c < 128 ? B64V[c] : -1;
    if (d < 0) throw new Error(`a character ${JSON.stringify(str[i])} that is not base64`);
    value += (d & 31) * 2 ** shift;
    if (d & 32) {
      shift += 5;
      if (shift > 30) throw new Error('a VLQ too long');
      continue;
    }
    seg.push(value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    value = 0;
    shift = 0;
  }
  if (shift) throw new Error('a cut VLQ');
  flush();
  for (const line of lines) line.sort((a, b) => a[0] - b[0]);
  return lines;
}

/**
 * lookup(lines, genLine, genCol) -> [src, srcLine] (0-based) or null: the
 * segment at or before the column on that line, else the line's first one.
 */
function lookup(lines, genLine, genCol) {
  const segs = lines[genLine];
  if (!segs || segs.length === 0) return null;
  let lo = 0;
  let hi = segs.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid][0] <= genCol) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const s = segs[at < 0 ? 0 : at];
  return s[1] < 0 ? null : [s[1], s[2]];
}

const URL_RE = /\/\/[#@][ \t]+sourceMappingURL=([^\s'"]+)[ \t]*$/;

/**
 * mapURL(src) -> the last sourceMappingURL comment's value, or null. Only a
 * comment at the end of the file counts (as Node and the browsers read it).
 */
function mapURL(src) {
  let end = src.length;
  for (let n = 0; n < 5 && end > 0; n++) {
    const start = src.lastIndexOf('\n', end - 1);
    const line = src.slice(start + 1, end).trimEnd();
    const m = URL_RE.exec(line);
    if (m) return m[1];
    if (line.trim() !== '') return null;
    if (start < 0) break;
    end = start;
  }
  return null;
}

/**
 * resolveSource(s, root, base, sourceRoot) -> the absolute file path a map
 * source names, or null when it names no file: a plain path (from the map's
 * dir, after sourceRoot), a file: URL, or a webpack:// URL
 * (webpack://<namespace>/<path>, the path from the app's root: webpack
 * writes it from its context, which is the project's dir).
 */
function resolveSource(s, root, base, sourceRoot) {
  if (typeof s !== 'string' || s === '') return null;
  if (s.startsWith('webpack://')) {
    const rest = s.slice('webpack://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    let p = rest.slice(slash + 1).split('?')[0];
    if (p === '' || /^(webpack|external)\b/.test(p) || p.includes(' ')) return null;
    if (p.startsWith('/')) return path.resolve(p);
    return path.resolve(root, p);
  }
  let p = sourceRoot && !s.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(s) ? sourceRoot.replace(/\/?$/, '/') + s : s;
  if (p.startsWith('webpack://')) return resolveSource(p, root, base, '');
  if (p.startsWith('file:')) {
    try {
      return fileURLToPath(p);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null; // http:, data:, ...
  return path.resolve(base, p);
}

// readMap(map, root, base) -> {sources, contents, lines} of a parsed map,
// a regular one or an index map (sections, each shifted by its offset).
function readMap(map, root, base) {
  if (map.version !== 3) throw new Error(`a source map of version ${map.version}`);
  if (Array.isArray(map.sections)) {
    const out = { sources: [], raw: [], contents: [], lines: [] };
    for (const sec of map.sections) {
      if (sec.url) throw new Error('an index source map whose section names a url');
      if (!sec.map || !sec.offset) throw new Error('an index source map section with no map or offset');
      const sub = readMap(sec.map, root, base);
      const at = out.sources.length;
      out.sources.push(...sub.sources);
      out.raw.push(...sub.raw);
      out.contents.push(...sub.contents);
      const L = sec.offset.line | 0;
      const C = sec.offset.column | 0;
      sub.lines.forEach((segs, i) => {
        const g = L + i;
        while (out.lines.length <= g) out.lines.push([]);
        for (const s of segs) {
          out.lines[g].push([s[0] + (i === 0 ? C : 0), s[1] < 0 ? -1 : s[1] + at, s[2], s[3]]);
        }
      });
    }
    for (const segs of out.lines) segs.sort((a, b) => a[0] - b[0]);
    return out;
  }
  if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) {
    throw new Error('a source map with no mappings or sources');
  }
  const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
  return {
    sources: map.sources.map((s) => resolveSource(s, root, base, sourceRoot)),
    raw: map.sources.map((s) => String(s)),
    contents: map.sources.map((_, i) => (Array.isArray(map.sourcesContent) && typeof map.sourcesContent[i] === 'string' ? map.sourcesContent[i] : null)),
    lines: decodeMappings(map.mappings),
  };
}

/**
 * load(file, src, root) -> {sources: [absolute path or null], contents:
 * [sourcesContent or null], lines, sha} for the generated file at file with
 * text src, or null when it names no map; sha is the sha256 of the map's
 * bytes (its data: URL for an inline one). A map that cannot be read throws.
 */
function load(file, src, root) {
  const url = mapURL(src);
  if (!url) return null;
  let raw;
  let base = path.dirname(file);
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('an inline source map with no data');
    const head = url.slice(5, comma);
    const body = url.slice(comma + 1);
    raw = /;base64$/i.test(head) ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('file:')) {
      throw new Error(`a source map at ${url}, which is no file`);
    }
    const bare = url.split(/[?#]/)[0];
    const mapFile = bare.startsWith('file:') ? fileURLToPath(bare) : path.resolve(base, decodeURIComponent(bare));
    raw = fs.readFileSync(mapFile, 'utf8');
    base = path.dirname(mapFile);
  }
  const out = readMap(JSON.parse(raw), root, base);
  out.sha = crypto.createHash('sha256').update(raw).digest('hex');
  return out;
}

module.exports = { decodeMappings, lookup, mapURL, load, resolveSource };
