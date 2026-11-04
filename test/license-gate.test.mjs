// Rows for the publish workflow's license check (scripts/license-gate.mjs):
// its classifier and its walk of an installed tree. The rows that run the
// script on packed tarballs are in license-gate-cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALLOWED, check, expressionIds, licenseFindings, textFindings } from '../scripts/license-gate.mjs';

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

// Each sample matches one pattern of the check, and the findings are listed
// whole: a pattern taken out of the check changes its row's list.
const flagged = [
  ['Licensed under LGPL-2.1 terms', ['GPL, LGPL or AGPL ("LGPL-2.1")']],
  ['AGPLv3 only', ['GPL, LGPL or AGPL ("AGPLv3")']],
  ['GPL-3.0 here', ['GPL, LGPL or AGPL ("GPL-3.0")']],
  ['the GNU Lesser General Public License applies', ['GPL, LGPL or AGPL ("GNU Lesser General Public License")']],
  ['see the gnu affero general public licence', ['GPL, LGPL or AGPL ("gnu affero general public licence")']],
  ['<https://www.gnu.org/licenses/>', ['GPL, LGPL or AGPL ("gnu.org/licenses")']],
  ['https://www.gnu.org/copyleft/', ['GPL, LGPL or AGPL ("gnu.org/copyleft")']],
  ['SPDX-License-Identifier: MPL-2.0', ['MPL ("MPL-2.0")']],
  ['subject to the Mozilla Public License, v. 2.0', ['MPL ("Mozilla Public License")']],
  ['https://www.mozilla.org/media/MPL/2.0/index.txt', ['MPL ("mozilla.org/media/MPL")']],
  ['http://mozilla.org/MPL/2.0/', ['MPL ("mozilla.org/MPL")']],
  ['License: Unicode-TOU', ['Unicode terms ("Unicode-TOU")']],
  ['Unicode-DFS-2016', ['Unicode terms ("Unicode-DFS-2016")']],
  ['UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE', ['Unicode terms ("UNICODE, INC. LICENSE AGREEMENT")']],
  ['Data Files and Software: Unicode Terms of Use apply', ['Unicode terms ("Unicode Terms of Use")']],
  ['http://www.unicode.org/copyright.html', ['Unicode terms ("unicode.org/copyright")']],
  ['SSPL', ['SSPL ("SSPL")']],
  ['the Server Side Public License', ['SSPL ("Server Side Public License")']],
  ['BUSL-1.1', ['BUSL ("BUSL")']],
  ['Business Source License 1.1', ['BUSL ("Business Source License")']],
  ['EPL-2.0', ['EPL ("EPL-2.0")']],
  ['Eclipse Public License', ['EPL ("Eclipse Public License")']],
  ['https://www.eclipse.org/legal/epl-v20.html', ['EPL ("eclipse.org/legal")']],
  ['CDDL', ['CDDL ("CDDL")']],
  ['Common Development and Distribution License', ['CDDL ("Common Development and Distribution License")']],
  ['EUPL', ['EUPL ("EUPL")']],
  ['European Union Public Licence', ['EUPL ("European Union Public Licence")']],
  ['OSL-3.0', ['OSL ("OSL-3.0")']],
  ['Open Software License', ['OSL ("Open Software License")']],
  ['CC-BY-SA', ['Creative Commons ("CC-BY-SA")']],
  ['https://creativecommons.org/licenses/by/4.0/', ['Creative Commons ("creativecommons.org/licenses/")']],
  ['Attribution-NonCommercial-ShareAlike', ['Creative Commons ("Attribution-NonCommercial-ShareAlike")']],
  ['Elastic-2.0', ['Elastic ("Elastic-2.0")']],
  ['the elastic license', ['Elastic ("elastic license")']],
  ['"Commons Clause" License Condition v1.0', ['Commons Clause ("Commons Clause")']],
  ['https://opensource.org/licenses/GPL-3.0', ['GPL, LGPL or AGPL ("GPL-3.0")', 'a license that is not allowed ("opensource.org/licenses/GPL-3.0")']],
  ['https://opensource.org/licenses/Artistic-2.0', ['a license that is not allowed ("opensource.org/licenses/Artistic-2.0")']],
];

test('a file naming a flagged license is found, by name, id or URL', () => {
  for (const [text, want] of flagged) assert.deepEqual(textFindings(text), want, text);
});

test('a file naming allowed licenses only is clean', () => {
  const clean = [
    'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy',
    'Licensed under the Apache License, Version 2.0 (the "License"); http://www.apache.org/licenses/LICENSE-2.0',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript and https://www.gnu.org/software/libc/',
    'https://creativecommons.org/publicdomain/zero/1.0/ and http://www.unicode.org/reports/tr44/',
    'const GPLAN = 1; mpl2(); // GPLx is not an id',
  ];
  for (const t of clean) assert.deepEqual(textFindings(t), [], t);
  const pages = ['MIT', 'mit-license.php', 'BSD-2-Clause', 'BSD-3-Clause', 'bsd-license.php', '0BSD', 'Apache-2.0', 'ISC', 'isc-license.txt', 'Zlib', 'zlib-license.php', 'BSL-1.0', 'Unlicense', 'PostgreSQL', 'OFL-1.1', 'MIT.html', 'mit-license.html.'];
  for (const p of pages) {
    const want = p === 'isc-license.txt' ? ['a license that is not allowed ("opensource.org/licenses/isc-license.txt")'] : [];
    assert.deepEqual(textFindings(`see https://opensource.org/licenses/${p}`), want, p);
  }
});

// What JSON.parse says of text that is not JSON, in this Node.
function parseError(text) {
  try {
    JSON.parse(text);
  } catch (err) {
    return err.message;
  }
  return '';
}

// A tree as npm installs it, written under a new directory.
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'license-gate-row-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

test('the walk reads every file under node_modules and every package folder, scoped and nested', (t) => {
  const root = tree({
    'package.json': { name: 'license-gate', license: 'GPL-3.0' }, // the project itself is not shipped
    'node_modules/.package-lock.json': { name: 'license-gate', lockfileVersion: 3 },
    'node_modules/.cache/x/data.json': '{}', // a dot folder is read, and is not a package
    'node_modules/.cache/package.json': { name: 'cache' },
    'node_modules/stray.txt': 'Mozilla Public License', // a file outside any package is read too
    'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
    'node_modules/a/index.js': 'module.exports = 1;',
    'node_modules/a/@x/y/z.js': '// a folder named @x inside a package is not a scope',
    'node_modules/a/@x/y/package.json': { name: 'y' },
    'node_modules/@s/stray': 'SSPL',
    'node_modules/@s/b/package.json': { name: '@s/b', version: '2.0.0', license: 'Apache-2.0' },
    'node_modules/@s/b/lib/x.js': '// fine',
    // A package.json inside a package (as module-type markers are) is a file
    // of it, not a package.
    'node_modules/@s/b/lib/package.json': { type: 'commonjs' },
    'node_modules/@s/b/node_modules/c/package.json': { name: 'c', version: '3.0.0', license: 'LGPL-3.0' },
    'node_modules/@s/b/node_modules/c/NOTICE': 'Mozilla Public License',
    'node_modules/@s/b/node_modules/@t/e2/package.json': { name: '@t/e2', version: '5.0.0', license: 'BUSL-1.1' },
    'node_modules/d/package.json': { name: 'd', version: '4.0.0', license: 'ISC' },
    'node_modules/d/ThirdPartyNoticeText.txt': 'UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE',
    'node_modules/e/index.js': 'no package.json here, so not a package',
    'node_modules/a/test/fixture/node_modules/util/index.js': '// a fixture folder, not a package',
    'node_modules/f/package.json': 'not json{',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // npm's bin links are not read (the files they name are, where they are);
  // any other link is a finding.
  mkdirSync(join(root, 'node_modules/.bin'));
  symlinkSync('../a/index.js', join(root, 'node_modules/.bin/tool'));
  symlinkSync('../a/index.js', join(root, 'node_modules/d/linked'));
  const { findings, packages, files } = check(root);
  assert.equal(packages, 6);
  assert.equal(files, 20);
  assert.deepEqual(findings.sort(), [
    'node_modules/stray.txt: MPL ("Mozilla Public License")',
    'node_modules/@s/stray: SSPL ("SSPL")',
    'node_modules/@s/b/node_modules/c (c@3.0.0): license "LGPL-3.0" is not allowed (field "LGPL-3.0")',
    'node_modules/@s/b/node_modules/c/NOTICE: MPL ("Mozilla Public License")',
    'node_modules/@s/b/node_modules/c/package.json: GPL, LGPL or AGPL ("LGPL-3.0")',
    'node_modules/@s/b/node_modules/@t/e2 (@t/e2@5.0.0): license "BUSL-1.1" is not allowed (field "BUSL-1.1")',
    'node_modules/@s/b/node_modules/@t/e2/package.json: BUSL ("BUSL")',
    'node_modules/d/ThirdPartyNoticeText.txt: Unicode terms ("UNICODE, INC. LICENSE AGREEMENT")',
    'node_modules/d/linked: not a file or a folder, so not read',
    `node_modules/f: no readable package.json (${parseError('not json{')})`,
  ].sort());
});

test('a clean tree has no findings, and an empty project has no packages', (t) => {
  const root = tree({
    'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
    'node_modules/a/LICENSE': 'MIT License\n\nPermission is hereby granted',
  });
  const empty = tree({ 'package.json': { name: 'license-gate' } });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  });
  assert.deepEqual(check(root), { findings: [], packages: 1, files: 2 });
  assert.deepEqual(check(empty), { findings: [], packages: 0, files: 0 });
});
