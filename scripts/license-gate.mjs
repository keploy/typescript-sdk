// license-gate.mjs TARBALL: the publish workflows' license check.
//
// TARBALL is the file `npm pack` wrote, the one the workflow then publishes.
// The check installs it into an empty project the way a user's `npm install`
// does, with install scripts off (no devDependencies; optional and peer
// dependencies in, whatever an npmrc or an npm_config_ variable says), once
// for each platform in PLATFORMS (npm's --os and --cpu), so that a dependency
// npm installs only on one of those platforms is checked too. It refuses the package
// when anything those installs put on disk for it names a license outside the
// allow-list below:
//   - each installed package's package.json license field (or the old
//     `licenses` list) must name allowed SPDX ids only. A missing field, an
//     id not on the list, "SEE LICENSE IN ..." and UNLICENSED all fail.
//   - every file of every installed package is read in full, whatever its
//     name, extension or size, a block at a time, for the names, ids and
//     URLs of the licenses in FLAGGED, for license pages (opensource.org,
//     choosealicense.com, spdx.org) that name no allowed license, and for
//     SPDX-License-Identifier lines that name an id not allowed. Text is
//     matched normalised (see normalise): in lower case, with any run of
//     spaces, hyphens, underscores and dots as one separator, so "CC BY 4.0",
//     "CC-BY-4.0" and "cc_by_4.0" are one spelling. A gzip file is read
//     decompressed; a file that starts with a UTF-16 byte order mark is read
//     as UTF-16, any other as UTF-8.
// A package's own peerDependencies are the user's install, not ours: the
// user's own jest or playwright tree is already in their project whatever we
// ship. The gate names them, and does not judge them. Peers of our
// dependencies are still judged, and so is anything the package or one of
// its dependencies needs too. Only the peers in USER_PEERS are left to the
// user: any other peerDependency of the package fails, until it is added
// there.
// Accepting a flagged file with a notice is not enough, so there is no
// exception list: a finding fails the publish.
//
// Limits, until licensegate's npm mode replaces this script:
//   - a license that FLAGGED does not name passes when only a file's text
//     names it (the Artistic License, say); a license field naming it fails.
//   - the id Unicode-3.0 is matched only in an SPDX-License-Identifier line
//     (code that cites "Unicode 3.0" most often names the standard).
//   - a name or id is matched only when what splits it is a separator above:
//     one split by markup, a comment marker or an escape, or spelt in other
//     than ASCII letters, is not.
//   - a license text in a language other than English (the Creative Commons
//     ports to German, French, Dutch, Austrian or Japanese law, say) passes
//     unless it also names a flagged id, English name or URL.
//   - only gzip is decompressed, one level deep: zip, xz, bzip2 and brotli
//     data, and UTF-16 text with no byte order mark, are read as their bytes.
//   - npm cannot install for another C library: an optional dependency for
//     musl (Alpine) Linux only is not installed, so not checked.
//   - only the platforms in PLATFORMS are installed for: an optional
//     dependency only for another (win32/arm64, linux/arm, ia32, the BSDs,
//     AIX, say) is not installed, so not checked.
//
// Exit 0 and print what was checked when the package is clean; exit 1 and
// list every finding when not, or when an install fails.
import { spawnSync } from 'node:child_process';
import { closeSync, createReadStream, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

export const ALLOWED = new Set([
  'MIT', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'ISC', 'Zlib',
  'BSL-1.0', 'CC0-1.0', 'Unlicense', 'PostgreSQL', 'OFL-1.1',
]);

// The peerDependencies of a package that are left to the user (see the
// header): those @keploy/jest and @keploy/playwright peer on.
export const USER_PEERS = new Set(['jest', 'jest-environment-node', '@playwright/test']);

// The platforms the tarball is installed for: the runner's, and those of
// other users, as npm's --os and --cpu name them.
export const PLATFORMS = [
  ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'],
];

// Text as it is matched: lower case, with each run of spaces, hyphens (any
// dash), underscores and dots made one space.
export function normalise(text) {
  return text.toLowerCase().replace(/[\s\-\u2010-\u2015_.]+/g, ' ');
}

// Each flagged license, written once, normalised: its ids, its names and its
// URLs. A space in a pattern is an optional separator ("cc by" also matches
// "ccby"), and a slash in a URL may be escaped ("\/", as JSON writes it).
// An id is matched as a word, with any version after it ("gplv3", "mpl 2 0").
const LICENSES = [
  ['GPL, LGPL or AGPL', {
    ids: ['(?:l|a)?gpl'],
    names: ['(?:gnu )?(?:(?:lesser|library|affero) )?general public licen[cs]e'],
    urls: ['gnu org/(?:licenses|copyleft)'],
  }],
  ['MPL', { ids: ['mpl'], names: ['mozilla public licen[cs]e'], urls: ['mozilla org/(?:[a-z]{2}(?: [a-z]{2})?/)?(?:media/)?mpl'] }],
  ['Unicode terms', {
    // Unicode-3.0 is matched only as an SPDX-License-Identifier (below):
    // "Unicode 3.0" in text names a version of the standard.
    ids: ['unicode (?:tou|dfs)'],
    names: ['unicode,? inc (?:licen[cs]e agreement|terms of use)', 'unicode terms of use', 'unicode licen[cs]e (?:agreement|v 3)'],
    urls: ['unicode org/(?:copyright|licen[cs]e|terms of use)'],
  }],
  ['SSPL', { ids: ['sspl'], names: ['server side public licen[cs]e'] }],
  ['BUSL', { ids: ['busl', 'bsl 1 1'], names: ['business source licen[cs]e'] }],
  ['EPL', { ids: ['epl'], names: ['eclipse public licen[cs]e'], urls: ['eclipse org/legal'] }],
  ['CDDL', { ids: ['cddl'], names: ['common development and distribution licen[cs]e'] }],
  ['EUPL', { ids: ['eupl'], names: ['european union public licen[cs]e'] }],
  ['OSL', { ids: ['osl v? \\d'], names: ['open software licen[cs]e'] }],
  ['CPL or CPAL', { ids: ['cpl v? \\d', 'cpal'], names: ['common public (?:attribution )?licen[cs]e'] }],
  ['Creative Commons', {
    ids: ['cc by(?: (?:nc|nd|sa)){0,3}'],
    // The 3.0 Unported legal code opens "Creative Commons Legal Code /
    // Attribution 3.0 Unported" (BY and its NC, ND and SA variants).
    names: ['creative commons (?:attribution|by|non commercial|share alike|no derivatives|noderivs|legal code attribution)', 'attribution (?:non commercial|share alike|no derivatives|noderivs)'],
    urls: ['creativecommons org/licenses'],
  }],
  ['ODbL', { ids: ['odbl'], names: ['open database licen[cs]e'] }],
  ['Elastic', { ids: ['elastic 2 0'], names: ['elastic licen[cs]e'] }],
  ['Commons Clause', { names: ['commons clause'] }],
  ['APSL, NPL, RPL, MS-RL or Sleepycat', {
    ids: ['apsl', 'npl v? \\d', 'rpl v? \\d', 'ms rl', 'sleepycat'],
    names: ['apple public source licen[cs]e', 'netscape public licen[cs]e', 'reciprocal public licen[cs]e', 'microsoft reciprocal licen[cs]e'],
  }],
];

const sep = (s) => s.replaceAll(' ', ' ?');
const VERSION = '(?: ?v)?(?: ?\\d{1,4}){0,3}';
export const FLAGGED = LICENSES.flatMap(([what, { ids = [], names = [], urls = [] }]) => [
  ...ids.map((p) => [what, new RegExp(`(?<![a-z0-9])(?:${sep(p)})${VERSION}(?![a-z0-9])`, 'g')]),
  ...names.map((p) => [what, new RegExp(sep(p), 'g')]),
  ...urls.map((p) => [what, new RegExp(sep(p).replaceAll('/', '\\\\?/'), 'g')]),
]);

// License pages: what follows the path names the license. The text is matched
// in lower case as it is written, so the page ends where the URL does.
const PAGE_URL = /(?:opensource\.org\\?\/licenses?|choosealicense\.com\\?\/licenses|spdx\.org\\?\/licenses)\\?\/([a-z0-9.+_-]{1,64})/g;
const ALLOWED_PAGES = new Set([...[...ALLOWED].map(normalise), 'mit license', 'bsd license', 'isc license', 'zlib license']);
const pageName = (page) => normalise(page).trim().replace(/ (?:php|html?|txt)$/, '');

// An SPDX-License-Identifier line names its ids as a license field does, and
// each must be allowed (ids are matched in any case, as SPDX says).
const SPDX_LINE = /spdx-license-identifier:[ \t]{0,8}([a-z0-9.+:() \t-]{1,80})/g;
const ALLOWED_IDS = new Set([...ALLOWED].map((id) => id.toLowerCase()));
const spdxIds = (expr) => expr.replace(/[()]/g, ' ').split(/[ \t]+/).map((t) => t.replace(/\.+$/, '')).filter((t) => /[a-z0-9]/.test(t) && !/^(?:or|and|with)$/.test(t));

// At least the longest text a pattern above matches (a license page URL, at
// up to 95 characters), and the context kept around it, so that text read a
// block at a time is matched as it would be whole.
const LONGEST = 128;
const BEFORE = 8;
const AFTER = 64;
export const KEEP = LONGEST + BEFORE + AFTER;

// Matches text pushed to it a piece at a time, keeping only the last KEEP
// characters of what came before: memory is bounded by the piece's size. A
// match is taken only where the window holds BEFORE characters before it
// and AFTER after it (or the text's start or end), so that a word cut at a
// window's edge is not read as a shorter one; the next window holds what the
// last one could not take yet.
export class Scanner {
  #norm = '';
  #raw = '';
  #normCut = false;
  #rawCut = false;
  #found = new Map();
  #pages = new Set();
  #ids = new Set();

  push(text) {
    this.#feed(text, false);
  }

  end() {
    this.#feed('', true);
    return this.findings();
  }

  findings() {
    return [
      ...[...this.#found].sort(([i], [j]) => i - j).map(([, f]) => f),
      ...[...this.#pages].map((u) => `a license that is not allowed (${JSON.stringify(u)})`),
      ...[...this.#ids].map((id) => `license ${JSON.stringify(id)} is not allowed (SPDX-License-Identifier)`),
    ];
  }

  #feed(text, last) {
    const norm = normalise(this.#norm + text);
    const raw = this.#raw + text.toLowerCase();
    FLAGGED.forEach(([what, re], i) => {
      if (this.#found.has(i)) return;
      const m = take(re, norm, this.#normCut, last);
      if (m) this.#found.set(i, `${what} (${JSON.stringify(m[0])})`);
    });
    for (let m, from = 0; (m = take(PAGE_URL, raw, this.#rawCut, last, from)); from = m.index + m[0].length) {
      if (!ALLOWED_PAGES.has(pageName(m[1]))) this.#pages.add(m[0]);
    }
    for (let m, from = 0; (m = take(SPDX_LINE, raw, this.#rawCut, last, from)); from = m.index + m[0].length) {
      for (const id of spdxIds(m[1])) if (!ALLOWED_IDS.has(id)) this.#ids.add(id);
    }
    this.#normCut ||= norm.length > KEEP;
    this.#rawCut ||= raw.length > KEEP;
    this.#norm = norm.slice(-KEEP);
    this.#raw = raw.slice(-KEEP);
  }
}

// The first match of re in window from from on that the window can judge:
// one that starts BEFORE characters in (when text was cut off before the
// window) and ends AFTER characters before the window's end (unless the text
// ends there), or null.
function take(re, window, cut, last, from = 0) {
  re.lastIndex = Math.max(from, cut ? BEFORE : 0);
  const m = re.exec(window);
  if (!m || (!last && m.index + m[0].length > window.length - AFTER)) return null;
  return m;
}

// The findings for one file's text, as "what (the text that matched)".
export function textFindings(text) {
  const s = new Scanner();
  s.push(text);
  return s.end();
}

// What a file's bytes start with: gzip's magic, or a UTF-16 byte order mark.
function encoding(head) {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

// The findings for the file at path, read in blocks of block bytes.
export async function fileFindings(path, block = 1 << 20) {
  const head = Buffer.alloc(2);
  const fd = openSync(path, 'r');
  let n;
  try {
    n = readSync(fd, head, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  let bytes = createReadStream(path, { highWaterMark: block });
  if (n === 2 && head[0] === 0x1f && head[1] === 0x8b) bytes = pipeline(bytes, createGunzip({ chunkSize: block }), () => {});
  const s = new Scanner();
  let decoder = null;
  let start = Buffer.alloc(0);
  try {
    for await (const chunk of bytes) {
      let piece = chunk;
      if (!decoder) {
        start = Buffer.concat([start, chunk]);
        if (start.length < 2) continue;
        decoder = new TextDecoder(encoding(start));
        piece = start;
      }
      s.push(decoder.decode(piece, { stream: true }));
    }
    // A file under 2 bytes names no license.
    if (decoder) s.push(decoder.decode());
  } catch (err) {
    return [`not readable (${err.message})`];
  }
  return s.end();
}

// The SPDX ids of a license expression: every id must be allowed, whatever
// joins them (OR, AND, WITH), since a scanner flags each id it reads.
export function expressionIds(expr) {
  return expr.replace(/[()]/g, ' ').split(/\s+/).filter((t) => t && !/^(?:OR|AND|WITH)$/.test(t));
}

// The findings for one installed package's license field.
export function licenseFindings(pkg) {
  let values;
  if (typeof pkg.license === 'string') values = [pkg.license];
  else if (pkg.license && typeof pkg.license.type === 'string') values = [pkg.license.type];
  else if (Array.isArray(pkg.licenses)) values = pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type));
  else return ['no license field'];
  const found = [];
  for (const v of values) {
    if (typeof v !== 'string' || v.trim() === '') {
      found.push('an empty license field');
      continue;
    }
    for (const id of expressionIds(v)) {
      if (!ALLOWED.has(id)) found.push(`license ${JSON.stringify(id)} is not allowed (field ${JSON.stringify(v)})`);
    }
  }
  return found;
}

// A package folder's package.json, or the error reading it.
function readPackage(dir) {
  try {
    return { pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
  } catch (err) {
    return { error: err.message };
  }
}

// The names a package needs, from the fields of its package.json named.
function needs(pkg, fields) {
  return fields.flatMap((f) => (pkg && pkg[f] && typeof pkg[f] === 'object' ? Object.keys(pkg[f]) : []));
}

// The findings for the tree installed in project for the package named root,
// and what was checked. Every package folder is found (node_modules/NAME and
// node_modules/@SCOPE/NAME, at any depth) and every file under node_modules
// is read, whichever package it belongs to, but for npm's own record of the
// tree (node_modules/.package-lock.json: the package.json files it copies are
// read where they are) and the packages only root's peerDependencies in
// USER_PEERS need (see the header), which are returned as user (and those peers as peers).
// A link is not read: npm
// makes links only in .bin folders, to files read where they are, so any
// other link, or anything that is not a file or a folder, is a finding.
export async function check(project, root) {
  const findings = [];
  const packages = new Map();
  const files = [];
  const walk = (dir, modules, scope, owner) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (modules && e.name.startsWith('@')) {
          walk(p, false, true, owner);
          continue;
        }
        // A folder with no package.json is not a package (a package's test
        // fixtures can sit under a node_modules folder of their own); its
        // files are read all the same.
        let o = owner;
        if ((scope || (modules && !e.name.startsWith('.'))) && existsSync(join(p, 'package.json'))) {
          packages.set(p, readPackage(p));
          o = p;
        }
        walk(p, e.name === 'node_modules', false, o);
      } else if (e.isFile()) {
        if (!(modules && e.name === '.package-lock.json')) files.push([p, owner]);
      } else if (!(e.isSymbolicLink() && basename(dir) === '.bin')) {
        findings.push(`${relative(project, p)}: not a file or a folder, so not read`);
      }
    }
  };
  const modules = join(project, 'node_modules');
  if (existsSync(modules)) walk(modules, true, false, null);

  // Where Node finds the package name from the package folder at dir.
  const find = (dir, name) => {
    for (let d = dir; d.startsWith(project); d = dirname(d)) {
      const p = join(d, 'node_modules', name);
      if (packages.has(p)) return p;
    }
    return null;
  };
  // The package folders reached from starts by the fields, and by peers but
  // for those of the folders in noPeers.
  const reach = (starts, noPeers) => {
    const seen = new Set();
    const todo = [...starts];
    while (todo.length) {
      const d = todo.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      const fields = noPeers.has(d) ? ['dependencies', 'optionalDependencies'] : ['dependencies', 'optionalDependencies', 'peerDependencies'];
      for (const name of needs(packages.get(d).pkg, fields)) {
        const p = find(d, name);
        if (p) todo.push(p);
      }
    }
    return seen;
  };
  const top = join(modules, root);
  let user = new Set();
  let peers = [];
  if (!packages.has(top)) findings.push(`${root}: not installed`);
  else {
    const ours = reach([top], new Set([top]));
    const own = needs(packages.get(top).pkg, ['peerDependencies']);
    for (const n of own) if (!USER_PEERS.has(n)) findings.push(`${root}: peerDependency ${JSON.stringify(n)} is not one left to the user (USER_PEERS), so it fails until it is added there`);
    peers = own.filter((n) => USER_PEERS.has(n)).map((n) => find(top, n)).filter(Boolean);
    user = new Set([...reach(peers, new Set())].filter((d) => !ours.has(d)));
  }

  let checked = 0;
  for (const [dir, { pkg, error }] of packages) {
    if (user.has(dir)) continue;
    checked++;
    const at = relative(project, dir);
    if (error) findings.push(`${at}: no readable package.json (${error})`);
    else findings.push(...licenseFindings(pkg).map((f) => `${at} (${pkg.name}@${pkg.version}): ${f}`));
  }
  let read = 0;
  for (const [p, owner] of files) {
    if (user.has(owner)) continue;
    read++;
    for (const f of await fileFindings(p)) findings.push(`${relative(project, p)}: ${f}`);
  }
  const name = (d) => {
    const { pkg } = packages.get(d);
    return pkg ? `${pkg.name}@${pkg.version}` : relative(project, d);
  };
  return { findings, packages: checked, files: read, user: [...user].map(name).sort(), peers: peers.filter((d) => user.has(d)).map(name).sort() };
}

// Installs tarball into the empty project, as a user's `npm install` does on
// platform ([os, cpu]) (npm never installs a dependency's devDependencies;
// no install script runs; the flags put optional and peer dependencies in
// over any npmrc or npm_config_ variable), and returns the package's name: the one
// dependency npm saved to the project's package.json. Throws, saying why, on
// a failure.
export function install(tarball, project, [os, cpu] = PLATFORMS[0]) {
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'license-gate', version: '0.0.0', private: true }));
  const args = ['install', '--ignore-scripts', '--include=optional', '--include=peer', '--legacy-peer-deps=false', '--no-audit', '--no-fund', '--no-package-lock', `--os=${os}`, `--cpu=${cpu}`, resolve(tarball)];
  const r = spawnSync('npm', args, { cwd: project, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm install ${tarball} for ${os}/${cpu} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${(r.stderr || '').trim()}`);
  const names = needs(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')), ['dependencies']);
  if (names.length !== 1) throw new Error(`installing ${tarball} for ${os}/${cpu} saved ${names.length} packages to the project, not 1`);
  return names[0];
}

export async function main(tarball) {
  if (!existsSync(tarball ?? '')) {
    console.error(`license gate: no package to check (${tarball || 'no TARBALL given'})`);
    return 1;
  }
  // Each finding once, with the platforms it was found on.
  const findings = new Map();
  const user = new Set();
  const peers = new Set();
  const counts = [];
  for (const platform of PLATFORMS) {
    const project = mkdtempSync(join(tmpdir(), 'license-gate-'));
    try {
      const root = install(tarball, project, platform);
      const r = await check(project, root);
      for (const f of r.findings) findings.set(f, [...(findings.get(f) || []), platform.join('/')]);
      for (const u of r.user) user.add(u);
      for (const p of r.peers) peers.add(p);
      counts.push(`${platform.join('/')}: ${r.packages} packages, ${r.files} files`);
    } catch (err) {
      console.error(`license gate: ${err.message}`);
      return 1;
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
  const skipped = user.size ? `; not checked, the user's own: ${user.size} packages its peerDependencies install (${[...peers].sort().join(', ')})` : '';
  if (findings.size) {
    console.error(`license gate: ${tarball} would ship ${findings.size} license finding(s):`);
    for (const [f, on] of findings) console.error(`  ${f}${on.length === PLATFORMS.length ? '' : ` (on ${on.join(', ')})`}`);
    console.error(`checked ${counts.join('; ')}${skipped}`);
    return 1;
  }
  console.log(`license gate: ${tarball}: ${counts.join('; ')}; every license allowed${skipped}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv[2]));
