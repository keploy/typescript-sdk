// Rows for the published declarations (dist/*.d.ts, built by npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

const dist = new URL('../dist/', import.meta.url);
const { peerDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The module each `from '...'`, `import '...'` and `import("...")` names.
function specifiers(text) {
  const found = [];
  for (const m of text.matchAll(/\bfrom\s+(['"])([^'"]+)\1|\bimport\s+(['"])([^'"]+)\3|\bimport\(\s*(['"])([^'"]+)\5\s*\)/g)) {
    found.push(m[2] ?? m[4] ?? m[6]);
  }
  return found;
}

test('the reader finds each kind of module a declaration names', () => {
  assert.deepEqual(specifiers(`import { a } from './a';\nimport type { B } from "b/c";\nimport 'd';\nexport declare const t: import("e").T<import('./f').F>;`), ['./a', 'b/c', 'd', 'e', './f']);
});

test('a declaration names only its own files, node and the packages a project installs (peerDependencies)', () => {
  const files = readdirSync(dist).filter((f) => f.endsWith('.d.ts'));
  assert.ok(files.includes('index.d.ts'), `dist holds no index.d.ts: ${files.join(', ')}`);
  const wrong = [];
  for (const f of files) {
    for (const s of specifiers(readFileSync(new URL(f, dist), 'utf8'))) {
      if (s.startsWith('./') || s.startsWith('../')) continue;
      if (s.startsWith('node:') || builtinModules.includes(s)) continue;
      if (Object.hasOwn(peerDependencies, s)) continue;
      wrong.push(`${f}: ${s}`);
    }
  }
  // A package a project does not install itself (playwright, which
  // @playwright/test re-exports) is one a strict installer such as pnpm
  // hides from it: the type would not resolve there.
  assert.deepEqual(wrong, [], `declarations name packages outside peerDependencies (${Object.keys(peerDependencies).join(', ')})`);
});
