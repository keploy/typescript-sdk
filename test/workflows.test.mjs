// Rows over the publish workflows themselves: each publishes the tarball its
// license check passed, and no job can hold a runner for GitHub's 6 hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const yaml = createRequire(import.meta.url)('js-yaml');
const load = (name) => yaml.load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const TARBALL = '${{ steps.pack.outputs.tarball }}';

// The steps of job, in order: each one's name (or command), run, env and id.
function steps(job) {
  return job.steps.map((s) => ({ name: s.name || s.run || s.uses, run: s.run || '', env: s.env || {}, id: s.id }));
}

const workflows = [
  // [file, publishing job, pull request job, the gate's path from the job's folder]
  ['sdk-publish.yml', 'publish', 'check', 'scripts/license-gate.mjs'],
  ['playwright-publish.yml', 'publish', 'dry-run', '../scripts/license-gate.mjs'],
  ['jest-publish.yml', 'publish', 'dry-run', '../scripts/license-gate.mjs'],
];

for (const [file, publish, pr, gate] of workflows) {
  test(`${file}: the tarball packed once is license-checked, then published`, () => {
    const wf = load(file);
    for (const job of [publish, pr]) {
      const s = steps(wf.jobs[job]);
      const at = (name) => s.findIndex((x) => x.name === name);
      const pack = at('Pack');
      assert.ok(pack >= 0, `${job}: a Pack step`);
      assert.equal(s[pack].id, 'pack');
      assert.match(s[pack].run, /^name=\$\(npm pack --pack-destination "\$RUNNER_TEMP" \| tail -n 1\)\n/);
      const lic = at('Licenses');
      assert.ok(lic > pack, `${job}: a Licenses step after Pack`);
      assert.equal(s[lic].run, `node ${gate} "$TARBALL"`);
      assert.equal(s[lic].env.TARBALL, TARBALL);
      // npm packs or publishes nothing else.
      assert.deepEqual(s.filter((x) => /\bnpm (?:pack|publish)\b/.test(x.run)).map((x) => x.name), job === publish ? ['Pack', 'Publish'] : file === 'sdk-publish.yml' ? ['Pack'] : ['Pack', 'Publish, dry run']);
      const pub = s.findIndex((x) => /\bnpm publish\b/.test(x.run));
      if (pub < 0) continue;
      assert.ok(pub > lic, `${job}: the publish runs after the Licenses step`);
      assert.match(s[pub].run, /^npm publish "\$TARBALL" /);
      assert.equal(s[pub].env.TARBALL, TARBALL);
    }
    assert.equal(steps(wf.jobs[publish]).find((x) => x.name === 'Publish').run, 'npm publish "$TARBALL" --access public --provenance');
  });

  test(`${file}: every job that runs on a runner has a timeout`, () => {
    const wf = load(file);
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (job.uses) continue; // a called workflow's jobs carry their own
      assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] <= 60, `${name}: timeout-minutes`);
    }
  });
}
