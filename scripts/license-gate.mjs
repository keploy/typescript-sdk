// license-gate.mjs TARBALL: the publish workflow's license check.
//
// TARBALL is the file `npm pack` wrote, the one the workflow then publishes.
// The check installs it into an empty project the way a user does (`npm
// install`, so no devDependencies), and refuses it when anything that install
// puts on disk names a license outside the allow-list below:
//   - each installed package's package.json license field (or the old
//     `licenses` list) must name allowed SPDX ids only. A missing field, an
//     id not on the list, "SEE LICENSE IN ..." and UNLICENSED all fail.
//   - every file of every installed package is read for the names, SPDX ids
//     and URLs of the licenses a scanner flags (LGPL, GPL, AGPL, MPL, Unicode
//     terms, SSPL, BUSL, EPL, CDDL, EUPL, OSL, CC-BY-SA and other Creative
//     Commons licenses, Elastic, Commons Clause), and for opensource.org
//     license URLs that name no allowed id.
// Accepting a flagged file with a notice is not enough, so there is no
// exception list: a finding fails the publish.
//
// Exit 0 and print what was checked when the package is clean; exit 1 and
// list every finding when not, or when the install fails.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED = new Set([
  'MIT', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'ISC', 'Zlib',
  'BSL-1.0', 'CC0-1.0', 'Unlicense', 'PostgreSQL', 'OFL-1.1',
]);

// opensource.org/licenses/<page>: the pages that name an allowed license.
const OSI_PAGES = new Map([
  ['mit', 'MIT'], ['mit-license', 'MIT'], ['bsd-2-clause', 'BSD-2-Clause'],
  ['bsd-3-clause', 'BSD-3-Clause'], ['bsd-license', 'BSD-3-Clause'], ['0bsd', '0BSD'],
  ['apache-2.0', 'Apache-2.0'], ['isc', 'ISC'], ['isc-license', 'ISC'], ['zlib', 'Zlib'],
  ['zlib-license', 'Zlib'], ['bsl-1.0', 'BSL-1.0'], ['unlicense', 'Unlicense'],
  ['postgresql', 'PostgreSQL'], ['ofl-1.1', 'OFL-1.1'],
]);

// What a scanner flags in a file, by name, SPDX id or URL. The SPDX ids are
// matched case-sensitively, as they are written; names and URLs in any case.
const FLAGGED = [
  ['GPL, LGPL or AGPL', /\b(?:L|A)?GPL(?:v?[123]|-[123]\.[01])?\b/],
  ['GPL, LGPL or AGPL', /GNU (?:Lesser |Library |Affero )?General Public Licen[cs]e/i],
  ['GPL, LGPL or AGPL', /gnu\.org\/(?:licenses|copyleft)/i],
  ['MPL', /\bMPL-?[12]\.[01]\b/],
  ['MPL', /Mozilla Public Licen[cs]e/i],
  ['MPL', /mozilla\.org\/(?:media\/)?MPL/i],
  ['Unicode terms', /\bUnicode-(?:TOU|DFS-20\d\d|3\.0)\b/],
  ['Unicode terms', /Unicode,? Inc\.? (?:License Agreement|Terms of Use)/i],
  ['Unicode terms', /Unicode Terms of Use/i],
  ['Unicode terms', /unicode\.org\/(?:copyright|license|terms_of_use)/i],
  ['SSPL', /\bSSPL\b/],
  ['SSPL', /Server Side Public Licen[cs]e/i],
  ['BUSL', /\bBUSL\b/],
  ['BUSL', /Business Source Licen[cs]e/i],
  ['EPL', /\bEPL-[12]\.0\b/],
  ['EPL', /Eclipse Public Licen[cs]e/i],
  ['EPL', /eclipse\.org\/legal/i],
  ['CDDL', /\bCDDL\b/],
  ['CDDL', /Common Development and Distribution Licen[cs]e/i],
  ['EUPL', /\bEUPL\b/],
  ['EUPL', /European Union Public Licen[cs]e/i],
  ['OSL', /\bOSL-[123]\.[01]\b/],
  ['OSL', /Open Software Licen[cs]e/i],
  ['Creative Commons', /\bCC-BY(?:-NC)?(?:-ND)?(?:-SA)?\b/],
  ['Creative Commons', /creativecommons\.org\/licenses\//i],
  ['Creative Commons', /Attribution-(?:NonCommercial-)?ShareAlike/i],
  ['Elastic', /\bElastic-2\.0\b/],
  ['Elastic', /Elastic Licen[cs]e/i],
  ['Commons Clause', /Commons Clause/i],
];

const OSI_URL = /opensource\.org\/licenses\/([A-Za-z0-9.+-]+)/gi;

// The findings for one file's text, as "what (the text that matched)".
export function textFindings(text) {
  const found = [];
  for (const [what, re] of FLAGGED) {
    const m = re.exec(text);
    if (m) found.push(`${what} (${JSON.stringify(m[0])})`);
  }
  for (const m of text.matchAll(OSI_URL)) {
    const page = m[1].toLowerCase().replace(/\.$/, '').replace(/\.(?:php|html?)$/, '');
    if (!OSI_PAGES.has(page)) found.push(`a license that is not allowed (${JSON.stringify(m[0])})`);
  }
  return found;
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

// The findings for one installed package's package.json, at its folder dir.
function packageFindings(dir, at) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    return [`${at}: no readable package.json (${err.message})`];
  }
  return licenseFindings(pkg).map((f) => `${at} (${pkg.name}@${pkg.version}): ${f}`);
}

// The findings for the tree installed in project, and what was checked.
// Every file under its node_modules is read, whichever package it belongs
// to (npm's own files there, such as .package-lock.json, included), and
// every package's package.json: node_modules/NAME and
// node_modules/@SCOPE/NAME, at any depth. A link is not read: npm makes
// links only in .bin folders, to files read where they are, so any other
// link, or anything that is not a file or a folder, is a finding.
export function check(project) {
  const findings = [];
  let packages = 0;
  let files = 0;
  const walk = (dir, modules, scope) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const at = relative(project, p);
      if (e.isDirectory()) {
        if (modules && e.name.startsWith('@')) {
          walk(p, false, true);
          continue;
        }
        // A folder with no package.json is not a package (a package's test
        // fixtures can sit under a node_modules folder of their own); its
        // files are read all the same.
        if ((scope || (modules && !e.name.startsWith('.'))) && existsSync(join(p, 'package.json'))) {
          packages++;
          findings.push(...packageFindings(p, at));
        }
        walk(p, e.name === 'node_modules', false);
      } else if (e.isFile()) {
        files++;
        for (const f of textFindings(readFileSync(p, 'latin1'))) findings.push(`${at}: ${f}`);
      } else if (!(e.isSymbolicLink() && basename(dir) === '.bin')) {
        findings.push(`${at}: not a file or a folder, so not read`);
      }
    }
  };
  const modules = join(project, 'node_modules');
  if (existsSync(modules)) walk(modules, true, false);
  return { findings, packages, files };
}

// Installs tarball into a new empty project, as a user's `npm install` does.
export function install(tarball, project) {
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'license-gate', version: '0.0.0', private: true }));
  const r = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', resolve(tarball)], { cwd: project, encoding: 'utf8' });
  if (r.status !== 0) return `npm install ${tarball} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${(r.stderr || '').trim()}`;
  return '';
}

export function main(tarball) {
  if (!existsSync(tarball ?? '')) {
    console.error(`license gate: no package to check (${tarball || 'no TARBALL given'})`);
    return 1;
  }
  const project = mkdtempSync(join(tmpdir(), 'license-gate-'));
  try {
    const failed = install(tarball, project);
    if (failed) {
      console.error(`license gate: ${failed}`);
      return 1;
    }
    const { findings, packages, files } = check(project);
    if (packages === 0) {
      console.error(`license gate: installing ${tarball} put no package on disk`);
      return 1;
    }
    if (findings.length) {
      console.error(`license gate: ${tarball} would ship ${findings.length} license finding(s) in ${packages} packages:`);
      for (const f of findings) console.error(`  ${f}`);
      return 1;
    }
    console.log(`license gate: ${tarball}: ${packages} packages, ${files} files, every license allowed`);
    return 0;
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
