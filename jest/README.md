# @keploy/jest

Joins a Jest suite to keploy's Universal Mocker. `keploy mock record` records the calls each test's code makes; `keploy mock replay` answers them from the recording, so the suite runs without its dependencies. keploy judges every recorded test, and lists each test it cannot replay with a reason.

This package tells keploy where each test begins and ends. Through it, keploy skips a test it set aside and fails a test whose calls changed. It speaks keploy's scope protocol v1, the same one go-sdk's `keploytest` and `@keploy/playwright` speak, and decides nothing itself.

## Use

The package is not published yet: build and pack it from this folder, then install the tarball it writes:

```sh
# in this folder
npm ci && npm run build && npm pack          # writes keploy-jest-0.1.0.tgz
# in your project
npm install --save-dev /path/to/keploy-jest-0.1.0.tgz
```

It needs Node.js 20 or later and Jest 29 or later with jest-circus, Jest's default test runner. Under another `testRunner` (`jest-jasmine2`), every test file fails with keploy's reason before any test runs: only jest-circus tells a test environment where each test starts and ends. Its rows run on Node.js 20, 22 and 24, each with Jest 29 and Jest 30. Its e2e lane (`e2e/lane.sh`) installs the packed package into a small suite and runs it under keploy 3.8.106: recorded with its provider up, replayed with the provider stopped.

It is a Jest test environment. Set it in the Jest config:

```js
// jest.config.js
module.exports = {
  testEnvironment: '@keploy/jest', // Node's environment, joined to keploy
};
```

To join another environment, such as jsdom, wrap its class in a file of your own and name that file as `testEnvironment`:

```js
// keploy-jsdom-environment.js
const { withKeploy } = require('@keploy/jest');
module.exports = withKeploy(require('jest-environment-jsdom').TestEnvironment);
```

keploy needs the project's `keploy.yml` to name the recording and CI's test command; without `mock.command`, keploy refuses the run with `no keploy project here: set mock.command ...`:

```yaml
# keploy.yml
mock:
  name: shop             # the recording: keploy/shop/
  command: npx jest -i   # CI's test command
```

Run the suite under keploy with `KEPLOY_PROVEN=1` and in one process (`-i`, Jest's `--runInBand`). `--local` keeps the recording on disk, in `keploy/<name>/`:

```sh
KEPLOY_PROVEN=1 keploy mock record --local -c "npx jest -i"
KEPLOY_PROVEN=1 keploy mock replay --local -c "npx jest -i"
```

`keploy mock record` runs the command against the real dependencies, then replays it twice to judge each test before it keeps the recording. `keploy mock replay` answers every call from the recording.

`KEPLOY_PROVEN=1` is keploy's switch for its proven model. keploy speaks this package's wire, scope protocol v1 (the claim, begin and end), only under it. Without it, keploy answers the claim with a plain 404, and every test file fails with `keploy: this keploy agent answered 404 to POST /agent/instance, so this Jest process cannot claim keploy's run: ...`, which names the switch.

keploy's first release runs one test process at a time. With more than one Jest worker, the second worker's claim is refused by keploy while the first is alive, and its test files fail with keploy's reason. `-i` runs every test file in Jest's own process.

## Without keploy

With `KEPLOY_MOCK_AGENT` unset or `off`, nothing changes: the environment is the one it wraps. Only `keploy mock record` and `keploy mock replay` set that variable.

## Under keploy

- **Claim.** The Jest process claims keploy's run before its first test file (`POST /agent/instance`), once for all the files it runs. The claim uses the Jest project's `displayName` as its key, or `.` without one, and names the project directory keploy names (`KEPLOY_MOCK_PROJECT`) as the folder the test files are named from (the current directory only when keploy names none). After the claim, `KEPLOY_TEST_PID` names the Jest process, so a process a test starts (the service under test, a helper) is a member of the run and claims nothing.
- **Begin.** Each test Jest runs begins (`POST /agent/scope/begin`) before its `beforeEach` hooks. keploy builds the test's ID as `[project::]file::titles`. The file is relative to the project directory. The titles are the describe blocks and the test's own title, joined with ` › `. The project is the `displayName`, when there is one. A test Jest itself skips (`test.skip`, `test.todo`, a test left out by `.only` or by `-t`) does not begin.
- **Skip.** When keploy has set a test aside, Jest skips it before any of its hooks, and keploy's reason is printed on stderr: `keploy: <reason> [skipped <file> › <titles>]`. Jest shows no reason for a skipped test, so the line is the reason.
- **End.** The test ends (`POST /agent/scope/end`) after its last `afterEach` hook, with its own outcome. When keploy saw a call with no recorded answer, or a recorded call the test no longer made, the test fails with keploy's text.

Any answer from the agent that this package cannot trust fails the test it belongs to; for the claim, every test file fails. That covers an agent it cannot reach, an error answer, an unreadable answer, and an answer that does not speak scope protocol v1. Nothing is retried. A test whose begin failed runs no `beforeEach` hook and no body, and does not end; its `afterEach` hooks still run, outside any test.

## Refused: tests keploy cannot judge one at a time

Each of these fails with its reason, on every run `jest.retryTimes` gives it, and none runs unjudged:

- A `test.concurrent` test. Its body would start before its turn, outside its window. It fails before its body runs; declare it with `test`.
- A title that repeats in one test file. keploy names a test by its file and titles, so a second test with the same name fails without beginning.
- A retry of `jest.retryTimes`. The retry would begin the same test a second time; it fails instead. A test refused for any reason (one of these, or an agent's answer this package cannot trust at its begin) stays refused on each retry: jest-circus clears a test's errors before it retries it, so the refusal is given again, and the retry runs no `beforeEach` hook and no body. Its `afterEach` hooks still run on each try, outside any test (jest-circus runs them even for a failed test). keploy sets aside a test it cannot prove, with its reason, and fails a test whose calls changed, and a retry changes neither.

## Limits of this version

- Calls that `beforeAll`/`afterAll` hooks make outside every test are answered from the process's claim.
- A skip's reason reaches the console, not Jest's report: Jest's results have no field for it.
- A test's begin is decided at Jest's `test_start` event, by Jest's own rule for which tests run (skip, todo, `.only`, `-t`). A Jest whose rule differs would start a test this package did not begin; that test fails with `keploy: Jest runs <titles>, which @keploy/jest did not begin ...` instead of running unjudged.

## Releasing

1. In a pull request, set `"version": "X.Y.Z"` in `jest/package.json`. The pull request's publish dry run checks the package.
2. Once it is merged, push the tag `jest-vX.Y.Z` on that commit of `main`: `git tag jest-vX.Y.Z <sha> && git push origin jest-vX.Y.Z`. The tag runs the rows and the e2e lane, then publishes to npm (`.github/workflows/jest-publish.yml`) with the repository secret `NPM_TOKEN`, an npm token that may publish to the `@keploy` scope.

Push the tag as a plain git tag. Never create a GitHub release for it: a published GitHub release also starts any workflow of this repository that runs on releases, such as the root `@keploy/sdk` release workflow (keploy/typescript-sdk#117), which would try to publish that package under the tag's name and fail.
