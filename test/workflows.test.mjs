// Rows over the workflows that publish to npm: each publishes the tarball its
// license check passed, and nothing in it skips that check or these rows;
// every pull request that changes one of them, these rows or the check runs
// these rows; and every job, those of a workflow one calls included, has a
// timeout, so none can hold a runner for GitHub's 6 hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const YAML = createRequire(import.meta.url)('yaml');
const dir = new URL('../.github/workflows/', import.meta.url);
const text = (name) => readFileSync(new URL(name, dir), 'utf8');
const load = (name) => YAML.parse(text(name));
const TARBALL = '${{ steps.pack.outputs.tarball }}';

// The steps of job, in order: each one's name (or command), run, env, id and
// the keys that can skip it or let it fail.
function steps(job) {
  return job.steps.map((s) => ({
    name: s.name || s.run || s.uses, run: s.run || '', env: s.env || {}, id: s.id,
    if: s.if, continueOnError: s['continue-on-error'], cwd: s['working-directory'],
  }));
}

// Whether GitHub's paths filter pattern p matches path: ** matches any
// characters, * any but a slash.
function matches(p, path) {
  const re = p.split(/(\*\*|\*)/).map((s) => (s === '**' ? '.*' : s === '*' ? '[^/]*' : s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${re}$`).test(path);
}

// What runs these rows from the repository's root in each job: the root's
// own rows (this file among them), or, in a job that works in a package's
// folder, the root's install (no scripts: only the YAML parser is needed) and
// this file.
const ALL_ROWS = { name: 'Rows', run: 'node --test test/*.test.mjs', cwd: undefined };
const WORKFLOW_ROWS = { name: 'Workflow rows', run: 'npm ci --ignore-scripts\nnode --test test/workflows.test.mjs\n', cwd: '.' };

const workflows = [
  // [file, tag, folder, publishing job, pull request job, the rows step, the gate's path from the folder]
  ['sdk-publish.yml', 'sdk-v*', undefined, 'publish', 'check', ALL_ROWS, 'scripts/license-gate.mjs'],
  ['playwright-publish.yml', 'playwright-v*', 'playwright', 'publish', 'dry-run', WORKFLOW_ROWS, '../scripts/license-gate.mjs'],
  ['jest-publish.yml', 'jest-v*', 'jest', 'publish', 'dry-run', WORKFLOW_ROWS, '../scripts/license-gate.mjs'],
];

test('every workflow that publishes to npm is one these rows hold', () => {
  const publishing = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n) && /\bnpm publish\b/.test(text(n))).sort();
  assert.deepEqual(publishing, workflows.map(([file]) => file).sort());
});

for (const [file, tag, folder, publish, pr, rows, gate] of workflows) {
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
      // Nothing else on the step: no shell of its own, and no other variable
      // (one that preloads code, say).
      const raw = wf.jobs[job].steps[lic];
      assert.deepEqual(Object.keys(raw).sort(), ['env', 'name', 'run'], `${job}: the Licenses step's keys`);
      assert.deepEqual(Object.keys(raw.env), ['TARBALL'], `${job}: the Licenses step's env`);
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

  test(`${file}: nothing skips the license check or the rows, or lets them fail`, () => {
    const wf = load(file);
    for (const [job, event] of [[publish, 'push'], [pr, 'pull_request']]) {
      const j = wf.jobs[job];
      // The job runs on its event, and on nothing narrower.
      assert.equal(j.if, `github.event_name == '${event}'`, `${job}: if`);
      assert.equal(j['continue-on-error'], undefined, `${job}: continue-on-error`);
      assert.equal(j.defaults.run['working-directory'], folder, `${job}: its folder`);
      const s = steps(j);
      for (const x of s) {
        assert.equal(x.if, undefined, `${job}: ${x.name}: if`);
        assert.equal(x.continueOnError, undefined, `${job}: ${x.name}: continue-on-error`);
      }
      const r = s.findIndex((x) => x.name === rows.name);
      assert.ok(r >= 0, `${job}: a ${rows.name} step`);
      assert.deepEqual([s[r].run, s[r].cwd], [rows.run, rows.cwd], `${job}: ${rows.name} runs from the root`);
      assert.ok(r < s.findIndex((x) => x.name === 'Licenses'), `${job}: ${rows.name} before Licenses`);
    }
    // A tag of this package's name starts the publish; any pull request that
    // touches what its paths name starts the check.
    assert.deepEqual(wf.on.push, { tags: [tag] });
    assert.deepEqual(Object.keys(wf.on.pull_request), ['paths']);
    assert.ok(wf.on.pull_request.paths.every((p) => !p.startsWith('!')), 'no path is excluded');
  });

  test(`${file}: a pull request that changes it, or the check, runs its own check and these rows`, () => {
    const own = load(file).on.pull_request.paths;
    const root = load('sdk-publish.yml').on.pull_request.paths;
    for (const path of [`.github/workflows/${file}`, 'scripts/license-gate.mjs', ...(folder ? [`${folder}/package.json`] : [])]) {
      assert.ok(own.some((p) => matches(p, path)), `${file} runs on a change to ${path}`);
    }
    // sdk-publish.yml's check runs every root row, these among them.
    for (const path of [`.github/workflows/${file}`, 'test/workflows.test.mjs', 'scripts/license-gate.mjs', 'package.json', 'package-lock.json']) {
      assert.ok(root.some((p) => matches(p, path)), `sdk-publish.yml runs on a change to ${path}`);
    }
  });

  test(`${file}: every job, a called workflow's included, has a timeout`, () => {
    const jobs = (wf, from) => Object.entries(wf.jobs).flatMap(([name, job]) => {
      if (!job.uses) return [[`${from}: ${name}`, job]];
      const called = job.uses.match(/^\.\/\.github\/workflows\/([^/@]+)$/);
      assert.ok(called, `${from}: ${name}: calls a workflow of this repository (${job.uses})`);
      return jobs(load(called[1]), called[1]);
    });
    const all = jobs(load(file), file);
    assert.ok(all.length >= 2);
    for (const [name, job] of all) {
      assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] <= 60, `${name}: timeout-minutes`);
    }
  });
}

test('the paths filter matches as GitHub does', () => {
  assert.ok(matches('scripts/**', 'scripts/license-gate.mjs'));
  assert.ok(matches('v2/**', 'v2/dedup/middleware.ts'));
  assert.ok(matches('.github/workflows/jest-*.yml', '.github/workflows/jest-sdk.yml'));
  assert.ok(!matches('.github/workflows/*.yml', '.github/workflows/sub/x.yml'));
  assert.ok(!matches('scripts/**', 'test/scripts/x.mjs'));
  assert.ok(!matches('package.json', 'jest/package.json'));
  assert.ok(!matches('a.b', 'axb'));
});
