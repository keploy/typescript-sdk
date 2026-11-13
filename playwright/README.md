# @keploy/playwright

Joins a Playwright suite to keploy's Universal Mocker. `keploy mock record` records the calls each test's browser and app server make; `keploy mock replay` answers them from the recording, so the suite runs without its backends. keploy judges every recorded test, and lists each test it cannot replay with a reason.

This package tells keploy where each test begins and ends. Through it, keploy skips a test it set aside and fails a test whose calls changed. It speaks keploy's scope protocol v1, the same one go-sdk's `keploytest` speaks, and decides nothing itself.

## Use

```sh
npm install --save-dev @keploy/playwright
```

It needs Node.js 20 or later. Its rows run on Node.js 20, 22 and 24.

Import `test` and `expect` from this package instead of `@playwright/test`. A fixture file that extends `test` extends this one:

```ts
import { test, expect } from '@keploy/playwright';

test('lists the apps', async ({ page }) => {
  await page.goto('/apps');
  await expect(page.getByRole('row')).toHaveCount(3);
});
```

Run the suite under keploy with `KEPLOY_PROVEN=1`, one worker and no retries:

```sh
KEPLOY_PROVEN=1 keploy mock record -c "npx playwright test --workers=1 --retries=0"
KEPLOY_PROVEN=1 keploy mock replay -c "npx playwright test --workers=1 --retries=0"
```

`KEPLOY_PROVEN=1` is keploy's switch for its proven model. keploy speaks this package's wire, scope protocol v1 (the claim, begin, end and given), only under it. Without it, keploy answers the worker's claim with a plain 404, and every test of the worker fails with `keploy: this keploy agent answered 404 to POST /agent/instance, so this worker cannot claim keploy's run: ...`, which names the switch.

keploy's first release runs one test process at a time. A second worker that is still alive while another runs is refused by keploy, and its tests fail. Turn retries off: keploy sets aside a test it cannot prove, with its reason, and fails a test whose calls changed, and a retry changes neither.

## Without keploy

With `KEPLOY_MOCK_AGENT` unset or `off`, nothing changes. Only `keploy mock record` and `keploy mock replay` set that variable.

## Under keploy

- **Claim.** Each worker claims keploy's run before its first hook or test (`POST /agent/instance`). The claim uses the worker's Playwright project name as its key, or `.` for an unnamed project, and names the project directory keploy names (`KEPLOY_MOCK_PROJECT`) as the folder of its tests, the folder the test files are named from (the current directory only when keploy names none). So a suite run from a folder above its keploy project, such as `cd .. && npx playwright test` in `mock.command`, is filed under its project. A worker that Playwright starts again after a failed test claims again.
- **Begin.** Each test begins (`POST /agent/scope/begin`) before its `beforeEach` hooks. keploy builds the test's ID as `[project::]file::titles`. The file is relative to the project directory keploy names (`KEPLOY_MOCK_PROJECT`). The titles are the describe groups and the test's own title, joined with ` › `.
- **Skip.** When keploy has set a test aside, the test is skipped through Playwright's own skip, and the report shows keploy's reason (`keploy: ...`).
- **Settle.** Before the test's `context` (and its `page`) closes, the test waits until none of its pages' calls is in flight. Calls are counted by the browser's own request events, and no time window decides. A call that never ends keeps the test waiting until Playwright's test timeout fails it. The test shows a step that names each call still in flight. A call is not waited for once the browser has cancelled it, which happens when its page loads another document, its frame is removed, its page closes or the test closes its own context. Nor are the calls a page's frames had in flight when the page loaded another document: the frames go with the old document, and Playwright reports no end for their calls, ordinary or keepalive (`navigator.sendBeacon`, `fetch` with `keepalive`, the telemetry a payment form's frame sends, which the browser goes on sending), so waiting for them would hold the test until its timeout. A closing page cancels only its own calls: a popup that closes cancels nothing of its opener's. A route change inside the page (the history API) cancels nothing, even after an answered call. A service worker's calls are counted too. No page's change drops them, but the test closing its own context does, as it ends the worker.
- **End.** The test ends (`POST /agent/scope/end`) after its last teardown, with its own outcome. When keploy saw a call with no recorded answer, or a recorded call the test no longer made, the test fails with keploy's text.
- **Given values.** `await given(name, value)` tells keploy a value the test made itself. Examples are a session token it signs and a name it stamps with the time. keploy then follows the value wherever the test's calls carry it, as it follows an incoming request's values in a server test. Give a distinctive value, whole, as the calls carry it. `given` must be called inside a test, or in its `beforeEach` or `afterEach` hooks. It returns the value. It needs a keploy whose agent serves `POST /agent/scope/given` (see the limits below).

Any answer from the agent that this package cannot trust fails the test. That covers an agent it cannot reach, an error answer, an unreadable answer, and an answer that does not speak scope protocol v1. Nothing is retried.

## Limits of this version

- Settle covers the `context` and `page` fixtures. A context the test makes with `browser.newContext()` is the test's own to close.
- Settle's rows run in Chromium. Which calls the browser itself ends (a removed frame's) is proven there only; Firefox and WebKit are not rowed.
- Calls that `beforeAll`/`afterAll` hooks and worker fixtures make outside every test are answered from the worker's claim, one slice per Playwright project.
- The `beforeAll` and `afterAll` hooks of a describe group whose tests keploy has all set aside still run, and their calls are answered from the claim. Each test is skipped at its begin, after the group's hooks have started; skipping the whole group before its hooks run needs a way to ask keploy for the set-aside tests first, which this version does not have.
- `given` needs the agent route `POST /agent/scope/given` (keploy/keploy#5016). keploy v3.6.192 and later serve it; with the enterprise keploy, that is an enterprise release on keploy v3.6.192 or later. An older keploy answers that route with a plain 404, and `given` fails the test with `keploy: this keploy agent answered 404 to POST /agent/scope/given, so it cannot take the given value <name>: given needs keploy v3.6.192 or later (keploy/keploy#5016), or an enterprise release on keploy v3.6.192 or later; an older keploy answers 404 there`. Claim, begin, settle and end do not need that route.

## Releasing

1. In a pull request, set `"version": "X.Y.Z"` in `playwright/package.json`. The pull request's publish dry run checks the package.
2. Once it is merged, push the tag `playwright-vX.Y.Z` on that commit of `main`: `git tag playwright-vX.Y.Z <sha> && git push origin playwright-vX.Y.Z`. The tag runs the rows, then publishes to npm (`.github/workflows/playwright-publish.yml`).

Push the tag as a plain git tag. Never create a GitHub release for it: a published GitHub release also starts any workflow of this repository that runs on releases, such as the root `@keploy/sdk` release workflow (keploy/typescript-sdk#117), which would try to publish that package under the tag's name and fail.
