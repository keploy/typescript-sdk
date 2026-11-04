// Rows for the publish workflows' license check (scripts/license-gate.mjs):
// its classifier, its reading of files, and its walk of an installed tree.
// The rows that run the script on packed tarballs are in
// license-gate-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ALLOWED, FLAGGED, KEEP, PLATFORMS, Scanner, check, expressionIds, fileFindings, licenseFindings, normalise, textFindings } from '../scripts/license-gate.mjs';

test('every allowed SPDX id passes, alone and in an expression', () => {
  const ids = ['MIT', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'ISC', 'Zlib', 'BSL-1.0', 'CC0-1.0', 'Unlicense', 'PostgreSQL', 'OFL-1.1'];
  assert.deepEqual([...ALLOWED].sort(), [...ids].sort());
  for (const id of ids) assert.deepEqual(licenseFindings({ license: id }), [], id);
  assert.deepEqual(licenseFindings({ license: '(MIT OR Apache-2.0)' }), []);
  assert.deepEqual(licenseFindings({ license: 'MIT AND ISC' }), []);
  assert.deepEqual(licenseFindings({ license: { type: 'ISC' } }), []);
  assert.deepEqual(licenseFindings({ licenses: [{ type: 'BSD-3-Clause' }, 'MIT'] }), []);
});

test('a license field naming anything else fails, each id on its own', () => {
  assert.deepEqual(licenseFindings({ license: 'LGPL-2.1' }), ['license "LGPL-2.1" is not allowed (field "LGPL-2.1")']);
  assert.deepEqual(licenseFindings({ license: '(MIT OR GPL-3.0)' }), ['license "GPL-3.0" is not allowed (field "(MIT OR GPL-3.0)")']);
  assert.deepEqual(licenseFindings({ license: 'MPL-2.0 AND Unicode-TOU' }), [
    'license "MPL-2.0" is not allowed (field "MPL-2.0 AND Unicode-TOU")',
    'license "Unicode-TOU" is not allowed (field "MPL-2.0 AND Unicode-TOU")',
  ]);
  // An exception id is not on the list either.
  assert.deepEqual(licenseFindings({ license: 'Apache-2.0 WITH LLVM-exception' }), ['license "LLVM-exception" is not allowed (field "Apache-2.0 WITH LLVM-exception")']);
  // An id that holds an operator's letters is still an id.
  assert.deepEqual(licenseFindings({ license: 'LicenseRef-ORACLE' }), ['license "LicenseRef-ORACLE" is not allowed (field "LicenseRef-ORACLE")']);
  assert.deepEqual(licenseFindings({ license: 'UNLICENSED' }), ['license "UNLICENSED" is not allowed (field "UNLICENSED")']);
  assert.match(licenseFindings({ license: 'SEE LICENSE IN LICENSE.md' }).join('\n'), /license "SEE" is not allowed/);
  assert.deepEqual(licenseFindings({ license: { type: 'EPL-2.0' } }), ['license "EPL-2.0" is not allowed (field "EPL-2.0")']);
  assert.deepEqual(licenseFindings({ licenses: [{ type: 'MIT' }, { type: 'CDDL-1.0' }] }), ['license "CDDL-1.0" is not allowed (field "CDDL-1.0")']);
  assert.deepEqual(licenseFindings({ licenses: [{ type: 'GPL-2.0' }] }), ['license "GPL-2.0" is not allowed (field "GPL-2.0")']);
  assert.deepEqual(licenseFindings({ license: 'WTFPL' }), ['license "WTFPL" is not allowed (field "WTFPL")']);
});

test('a missing or empty license field fails', () => {
  assert.deepEqual(licenseFindings({ name: 'x' }), ['no license field']);
  assert.deepEqual(licenseFindings({ license: { url: 'https://example.com' } }), ['no license field']);
  assert.deepEqual(licenseFindings({ license: '' }), ['an empty license field']);
  assert.deepEqual(licenseFindings({ license: '   ' }), ['an empty license field']);
  assert.deepEqual(licenseFindings({ licenses: [{ url: 'https://example.com' }] }), ['an empty license field']);
});

test('the ids of an expression drop only parentheses and operators', () => {
  assert.deepEqual(expressionIds('((MIT OR Apache-2.0) AND BSD-3-Clause)'), ['MIT', 'Apache-2.0', 'BSD-3-Clause']);
  assert.deepEqual(expressionIds('GPL-2.0 WITH Classpath-exception-2.0'), ['GPL-2.0', 'Classpath-exception-2.0']);
});

test('text is matched in lower case, with any run of separators as one space', () => {
  assert.equal(normalise('CC BY 4.0'), 'cc by 4 0');
  assert.equal(normalise('CC-BY-4.0'), 'cc by 4 0');
  assert.equal(normalise('cc_by_4.0'), 'cc by 4 0');
  assert.equal(normalise('CC \t- _.\n BY–SA'), 'cc by sa');
  assert.equal(normalise('a/b,c'), 'a/b,c');
});

// Each sample and every finding it gives, listed whole: a pattern taken out
// of the check, or loosened or narrowed, changes some row's list.
const flagged = [
  ['Licensed under LGPL-2.1 terms', ['GPL, LGPL or AGPL ("lgpl 2 1")']],
  ['AGPLv3 only', ['GPL, LGPL or AGPL ("agplv3")']],
  ['GPL-3.0-or-later here', ['GPL, LGPL or AGPL ("gpl 3 0")']],
  ['see https://choosealicense.com/licenses/lgpl-3.0/', ['GPL, LGPL or AGPL ("lgpl 3 0")', 'a license that is not allowed ("choosealicense.com/licenses/lgpl-3.0")']],
  ['License: https://opensource.org/license/gpl-3-0', ['GPL, LGPL or AGPL ("gpl 3 0")', 'a license that is not allowed ("opensource.org/license/gpl-3-0")']],
  ['the GNU Lesser General Public License applies', ['GPL, LGPL or AGPL ("gnu lesser general public license")']],
  ['see the gnu affero general public licence', ['GPL, LGPL or AGPL ("gnu affero general public licence")']],
  ['GNU Library General Public License', ['GPL, LGPL or AGPL ("gnu library general public license")']],
  ['under the General_Public_License', ['GPL, LGPL or AGPL ("general public license")']],
  ['<https://www.gnu.org/licenses/>', ['GPL, LGPL or AGPL ("gnu org/licenses")']],
  ['https://www.gnu.org/copyleft/', ['GPL, LGPL or AGPL ("gnu org/copyleft")']],
  ['"https:\\/\\/www.GNU.org\\/licenses\\/"', ['GPL, LGPL or AGPL ("gnu org\\\\/licenses")']],
  ['SPDX-License-Identifier: MPL-2.0', ['MPL ("mpl 2 0")', 'license "mpl-2.0" is not allowed (SPDX-License-Identifier)']],
  ['Portions are licensed under MPL 2.0.', ['MPL ("mpl 2 0")']],
  ['MPL2.0', ['MPL ("mpl2 0")']],
  ['subject to the Mozilla Public License, v. 2.0', ['MPL ("mozilla public license")']],
  ['Mozilla Public Licence', ['MPL ("mozilla public licence")']],
  ['https://www.mozilla.org/media/MPL/2.0/index.txt', ['MPL ("mpl")', 'MPL ("mozilla org/media/mpl")']],
  ['http://mozilla.org/MPL/2.0/', ['MPL ("mpl")', 'MPL ("mozilla org/mpl")']],
  ['https://www.mozilla.org/en-US/MPL/', ['MPL ("mpl")', 'MPL ("mozilla org/en us/mpl")']],
  ['License: Unicode-TOU', ['Unicode terms ("unicode tou")']],
  ['Unicode-DFS-2016', ['Unicode terms ("unicode dfs 2016")']],
  ['/* SPDX-License-Identifier: Unicode-3.0 */', ['license "unicode-3.0" is not allowed (SPDX-License-Identifier)']],
  ['// spdx-license-identifier:\t(MIT OR Artistic-2.0).', ['license "artistic-2.0" is not allowed (SPDX-License-Identifier)']],
  ['# SPDX-License-Identifier: BSD-3-Clause\nSPDX-License-Identifier: WTFPL AND ISC', ['license "wtfpl" is not allowed (SPDX-License-Identifier)']],
  ['UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE', ['Unicode terms ("unicode, inc license agreement")']],
  ['Unicode, Inc. Terms of Use', ['Unicode terms ("unicode, inc terms of use")']],
  ['Data Files and Software: Unicode Terms of Use apply', ['Unicode terms ("unicode terms of use")']],
  ['UNICODE LICENSE V3', ['Unicode terms ("unicode license v3")']],
  ['the Unicode License Agreement', ['Unicode terms ("unicode license agreement")']],
  ['http://www.unicode.org/copyright.html', ['Unicode terms ("unicode org/copyright")']],
  ['https://www.unicode.org/license.txt', ['Unicode terms ("unicode org/license")']],
  ['http://www.unicode.org/terms_of_use.html', ['Unicode terms ("unicode org/terms of use")']],
  ['SSPL-1.0', ['SSPL ("sspl 1 0")']],
  ['the Server Side Public License', ['SSPL ("server side public license")']],
  ['BUSL-1.1', ['BUSL ("busl 1 1")']],
  ['MariaDB BSL 1.1', ['BUSL ("bsl 1 1")']],
  ['Business Source License 1.1', ['BUSL ("business source license")']],
  ['EPL-2.0', ['EPL ("epl 2 0")']],
  ['Eclipse Public License', ['EPL ("eclipse public license")']],
  ['https://www.eclipse.org/legal/epl-v20.html', ['EPL ("epl v20")', 'EPL ("eclipse org/legal")']],
  ['CDDL-1.0', ['CDDL ("cddl 1 0")']],
  ['Common Development and Distribution License', ['CDDL ("common development and distribution license")']],
  ['EUPL-1.2', ['EUPL ("eupl 1 2")']],
  ['European Union Public Licence', ['EUPL ("european union public licence")']],
  ['OSL-3.0', ['OSL ("osl 3 0")']],
  ['Open Software License', ['OSL ("open software license")']],
  ['CPL-1.0', ['CPL or CPAL ("cpl 1 0")']],
  ['CPAL-1.0', ['CPL or CPAL ("cpal 1 0")']],
  ['Common Public Attribution License', ['CPL or CPAL ("common public attribution license")']],
  ['CC-BY-4.0', ['Creative Commons ("cc by 4 0")']],
  ['This data is licensed CC BY 4.0.', ['Creative Commons ("cc by 4 0")']],
  ['CC BY-SA 4.0', ['Creative Commons ("cc by sa 4 0")']],
  ['cc_by_nc_nd_4.0', ['Creative Commons ("cc by nc nd 4 0")']],
  ['Creative Commons Attribution 4.0 International', ['Creative Commons ("creative commons attribution")']],
  ['Creative Commons BY-SA', ['Creative Commons ("creative commons by")']],
  ['Attribution-NonCommercial-ShareAlike', ['Creative Commons ("attribution noncommercial")']],
  ['Attribution-ShareAlike 4.0 International', ['Creative Commons ("attribution sharealike")']],
  ['https://creativecommons.org/licenses/by/4.0/', ['Creative Commons ("creativecommons org/licenses")']],
  ['ODbL-1.0', ['ODbL ("odbl 1 0")']],
  ['Open Database License', ['ODbL ("open database license")']],
  ['Elastic-2.0', ['Elastic ("elastic 2 0")']],
  ['the elastic license', ['Elastic ("elastic license")']],
  ['"Commons Clause" License Condition v1.0', ['Commons Clause ("commons clause")']],
  ['APSL-2.0', ['APSL, NPL, RPL, MS-RL or Sleepycat ("apsl 2 0")']],
  ['NPL-1.1', ['APSL, NPL, RPL, MS-RL or Sleepycat ("npl 1 1")']],
  ['RPL-1.5', ['APSL, NPL, RPL, MS-RL or Sleepycat ("rpl 1 5")']],
  ['MS-RL', ['APSL, NPL, RPL, MS-RL or Sleepycat ("ms rl")']],
  ['Sleepycat', ['APSL, NPL, RPL, MS-RL or Sleepycat ("sleepycat")']],
  ['Apple Public Source License', ['APSL, NPL, RPL, MS-RL or Sleepycat ("apple public source license")']],
  ['Netscape Public License', ['APSL, NPL, RPL, MS-RL or Sleepycat ("netscape public license")']],
  ['Reciprocal Public License', ['APSL, NPL, RPL, MS-RL or Sleepycat ("reciprocal public license")']],
  ['Microsoft Reciprocal License', ['APSL, NPL, RPL, MS-RL or Sleepycat ("microsoft reciprocal license")']],
  ['https://opensource.org/licenses/Artistic-2.0', ['a license that is not allowed ("opensource.org/licenses/artistic-2.0")']],
  ['https://spdx.org/licenses/Artistic-2.0.html', ['a license that is not allowed ("spdx.org/licenses/artistic-2.0.html")']],
  ['see https://opensource.org/licenses/MIT and https://opensource.org/license/artistic-2-0', ['a license that is not allowed ("opensource.org/license/artistic-2-0")']],
  ['"https:\\/\\/opensource.org\\/licenses\\/Artistic-2.0"', ['a license that is not allowed ("opensource.org\\\\/licenses\\\\/artistic-2.0")']],
];

test('a file naming a flagged license is found, by name, id or URL, in any spelling', () => {
  for (const [text, want] of flagged) assert.deepEqual(textFindings(text), want, text);
  // Every pattern of the check is some sample's.
  const labels = new Set(flagged.flatMap(([, w]) => w.map((f) => f.replace(/ \(.*$/, ''))));
  for (const [what] of FLAGGED) assert.ok(labels.has(what), what);
});

const clean = [
  'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy',
  'Licensed under the Apache License, Version 2.0 (the "License"); http://www.apache.org/licenses/LICENSE-2.0',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript and https://www.gnu.org/software/libc/',
  'https://creativecommons.org/publicdomain/zero/1.0/ and http://www.unicode.org/reports/tr44/ and CC0-1.0',
  'const GPLAN = 1; // GPLx is not an id, nor is cplus or nplx',
  'a sample template example: implement the epilogue; Simpl.js, templ and hepl',
  'BSL-1.0 is the Boost license; see https://opensource.org/licenses',
  '// SPDX-License-Identifier: (MIT OR Apache-2.0) */ and <!-- SPDX-License-Identifier: CC0-1.0 --> and SPDX-License-Identifier: 0BSD.',
  '// Check for surrogate pairs (reference Unicode 3.0 section "3.7 Surrogates").',
  'elastic band; Unicode 15 tables; the commons; creative work; attribution required',
];

test('a file naming allowed licenses only is clean', () => {
  for (const t of clean) assert.deepEqual(textFindings(t), [], t);
  const pages = ['MIT', 'mit-license.php', 'BSD-2-Clause', 'BSD-3-Clause', 'bsd-license.php', '0BSD', 'Apache-2.0', 'apache-2-0', 'ISC', 'isc-license.txt', 'isc-license-txt', 'Zlib', 'zlib-license.php', 'BSL-1.0', 'bsl-1-0', 'CC0-1.0', 'Unlicense', 'PostgreSQL', 'OFL-1.1', 'MIT.html', 'mit-license.html.', 'MIT.htm'];
  for (const host of ['https://opensource.org/licenses/', 'https://opensource.org/license/', 'https://choosealicense.com/licenses/', 'https://spdx.org/licenses/', 'HTTPS://OPENSOURCE.ORG/LICENSES/']) {
    for (const p of pages) assert.deepEqual(textFindings(`see ${host}${p} for the terms`), [], host + p);
  }
});

// The findings for text pushed to a Scanner in pieces of size n.
function inPieces(text, n) {
  const s = new Scanner();
  for (let i = 0; i < text.length; i += n) s.push(text.slice(i, i + n));
  return s.end();
}

test('text read a piece at a time is matched as it would be whole', () => {
  for (const [text] of [...flagged, ...clean.map((t) => [t])]) {
    for (const n of [1, 2, 7]) assert.deepEqual(inPieces(`${'x '.repeat(KEEP)}${text}`, n), textFindings(text), `${n}: ${text}`);
  }
  // A match far into a long text, cut across pieces, is found.
  const long = `${'x'.repeat(5000)} Mozilla Public License ${'y'.repeat(5000)}`;
  assert.deepEqual(inPieces(long, 100), ['MPL ("mozilla public license")']);
  assert.deepEqual(inPieces(long, 5011), ['MPL ("mozilla public license")']);
  // A match at the very start, before a long run of separators, is found.
  assert.deepEqual(inPieces(`GPL${' '.repeat(5000)}x`, 1000), ['GPL, LGPL or AGPL ("gpl")']);
  // A word cut at the end of a piece is not read as a shorter one.
  const s = new Scanner();
  s.push(`${'x'.repeat(5000)} gpl`);
  s.push('an and https://opensource.org/licenses/mi');
  s.push('t-license.php');
  assert.deepEqual(s.end(), []);
  // A long license URL cut across pieces is found whole.
  const page = `choosealicense.com/licenses/${'a'.repeat(64)}`;
  const u = new Scanner();
  u.push(`${'x'.repeat(5000)} https://${page}`);
  u.push(' and more');
  assert.deepEqual(u.end(), [`a license that is not allowed (${JSON.stringify(page)})`]);
  // Nor is a word whose start was cut off before the window.
  const t = new Scanner();
  t.push(`${'b'.repeat(1000)}agpl ${'c'.repeat(KEEP - 4)}`);
  t.push('d');
  assert.deepEqual(t.end(), []);
});

const work = mkdtempSync(join(tmpdir(), 'license-gate-row-'));
test.after(() => rmSync(work, { recursive: true, force: true }));
let nfile = 0;
const file = (body) => {
  const p = join(work, `f${nfile++}`);
  writeFileSync(p, body);
  return p;
};

test('every file is read whole, whatever its name or size, a block at a time', async () => {
  const big = `${'x'.repeat(3 << 20)}\n/* Mozilla Public License 2.0 */\n`;
  assert.deepEqual(await fileFindings(file(big)), ['MPL ("mozilla public license")']);
  assert.deepEqual(await fileFindings(file(big), 4096), ['MPL ("mozilla public license")']);
  // A UTF-8 character split across blocks is read whole.
  assert.deepEqual(await fileFindings(file('CC BY 4.0'), 3), ['Creative Commons ("cc by 4 0")']);
  assert.deepEqual(await fileFindings(file('')), []);
  assert.deepEqual(await fileFindings(file('G')), []);
});

test('a gzip file is read decompressed, and UTF-16 text by its byte order mark', async () => {
  const gpl = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n';
  const want = ['GPL, LGPL or AGPL ("gnu general public license")'];
  assert.deepEqual(await fileFindings(file(gzipSync(Buffer.from(gpl)))), want);
  assert.deepEqual(await fileFindings(file(gzipSync(Buffer.from(gpl.repeat(1 << 15)))), 512), want);
  const le = Buffer.from(`﻿${gpl}`, 'utf16le');
  assert.deepEqual(await fileFindings(file(le)), want);
  assert.deepEqual(await fileFindings(file(le), 1), want);
  assert.deepEqual(await fileFindings(file(Buffer.from(le).swap16())), want);
  assert.deepEqual(await fileFindings(file(gzipSync(le))), want);
  const bad = await fileFindings(file(Buffer.from([0x1f, 0x8b, 1, 2, 3, 4])));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^not readable \(.+\)$/);
});

// A tree as npm installs it, written under a new directory.
function tree(files) {
  const root = mkdtempSync(join(work, 'tree-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

// What JSON.parse says of text that is not JSON, in this Node.
function parseError(text) {
  try {
    JSON.parse(text);
  } catch (err) {
    return err.message;
  }
  return '';
}

test('the walk reads every package folder and file but the user\'s own peers, scoped and nested', async () => {
  const root = tree({
    'package.json': { name: 'license-gate', license: 'GPL-3.0' }, // the project itself is not shipped
    'node_modules/.package-lock.json': { packages: { 'node_modules/q': { license: 'MPL-2.0' } } }, // npm's record, not read
    'node_modules/.cache/x/data.json': '{}', // a dot folder is read, and is not a package
    'node_modules/.cache/package.json': { name: 'cache' },
    'node_modules/stray.txt': 'Mozilla Public License', // a file outside any package is read too
    'node_modules/top/package.json': { name: 'top', version: '1.0.0', license: 'MIT', dependencies: { a: '1', '@s/b': '2' }, optionalDependencies: { d: '4', ghost: '9' }, peerDependencies: { p: '1', a: '1' } },
    'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
    'node_modules/a/index.js': 'module.exports = 1;',
    'node_modules/a/.package-lock.json': 'Mozilla Public License', // a package's own file of that name is read
    'node_modules/a/@x/y/z.js': '// a folder named @x inside a package is not a scope',
    'node_modules/a/@x/y/package.json': { name: 'y' },
    'node_modules/@s/stray': 'SSPL',
    'node_modules/@s/b/package.json': { name: '@s/b', version: '2.0.0', license: 'Apache-2.0', dependencies: { c: '3', '@t/e2': '5' } },
    'node_modules/@s/b/lib/x.js': '// fine',
    // A package.json inside a package (as module-type markers are) is a file
    // of it, not a package.
    'node_modules/@s/b/lib/package.json': { type: 'commonjs' },
    'node_modules/@s/b/node_modules/c/package.json': { name: 'c', version: '3.0.0', license: 'LGPL-3.0', peerDependencies: { r: '1' } },
    'node_modules/@s/b/node_modules/c/NOTICE': 'Mozilla Public License',
    'node_modules/@s/b/node_modules/@t/e2/package.json': { name: '@t/e2', version: '5.0.0', license: 'BUSL-1.1' },
    'node_modules/d/package.json': { name: 'd', version: '4.0.0', license: 'ISC' },
    'node_modules/d/ThirdPartyNoticeText.txt': 'UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE',
    'node_modules/e/index.js': 'no package.json here, so not a package',
    'node_modules/a/test/fixture/node_modules/util/index.js': '// a fixture folder, not a package',
    'node_modules/f/package.json': 'not json{',
    // The peer of a dependency is the package's to ship: checked, though the
    // user's peer p needs it too.
    'node_modules/r/package.json': { name: 'r', version: '1.0.0', license: 'EPL-2.0' },
    // top's own peer, and what only it needs, are the user's: not checked.
    // What top needs too (a) is checked all the same.
    'node_modules/p/package.json': { name: 'p', version: '1.0.0', license: 'GPL-3.0', dependencies: { q: '1', a: '1', r: '1' } },
    'node_modules/p/COPYING': 'GNU General Public License',
    'node_modules/p/node_modules/q/package.json': { name: 'q', version: '1.0.0', license: 'MPL-2.0' },
  });
  // npm's bin links are not read (the files they name are, where they are);
  // any other link is a finding.
  mkdirSync(join(root, 'node_modules/.bin'));
  symlinkSync('../a/index.js', join(root, 'node_modules/.bin/tool'));
  symlinkSync('../a/index.js', join(root, 'node_modules/d/linked'));
  const { findings, packages, files, user, peers } = await check(root, 'top');
  assert.deepEqual(user, ['p@1.0.0', 'q@1.0.0']);
  assert.deepEqual(peers, ['p@1.0.0']);
  assert.equal(packages, 8);
  assert.equal(files, 22);
  assert.deepEqual(findings.sort(), [
    'node_modules/stray.txt: MPL ("mozilla public license")',
    'node_modules/a/.package-lock.json: MPL ("mozilla public license")',
    'node_modules/@s/stray: SSPL ("sspl")',
    'node_modules/@s/b/node_modules/c (c@3.0.0): license "LGPL-3.0" is not allowed (field "LGPL-3.0")',
    'node_modules/@s/b/node_modules/c/NOTICE: MPL ("mozilla public license")',
    'node_modules/@s/b/node_modules/c/package.json: GPL, LGPL or AGPL ("lgpl 3 0")',
    'node_modules/@s/b/node_modules/@t/e2 (@t/e2@5.0.0): license "BUSL-1.1" is not allowed (field "BUSL-1.1")',
    'node_modules/@s/b/node_modules/@t/e2/package.json: BUSL ("busl 1 1")',
    'node_modules/d/ThirdPartyNoticeText.txt: Unicode terms ("unicode, inc license agreement")',
    'node_modules/d/linked: not a file or a folder, so not read',
    `node_modules/f: no readable package.json (${parseError('not json{')})`,
    'node_modules/r (r@1.0.0): license "EPL-2.0" is not allowed (field "EPL-2.0")',
    'node_modules/r/package.json: EPL ("epl 2 0")',
  ].sort());
});

test('a clean tree has no findings; a package that is not there is one', async () => {
  const root = tree({
    'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT', peerDependencies: { gone: '1' } },
    'node_modules/a/LICENSE': 'MIT License\n\nPermission is hereby granted',
  });
  const empty = tree({ 'package.json': { name: 'license-gate' } });
  assert.deepEqual(await check(root, 'a'), { findings: [], packages: 1, files: 2, user: [], peers: [] });
  assert.deepEqual(await check(empty, 'a'), { findings: ['a: not installed'], packages: 0, files: 0, user: [], peers: [] });
});

test('the tarball is installed for the runner and for other users\' platforms', () => {
  assert.deepEqual(PLATFORMS, [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]);
});
