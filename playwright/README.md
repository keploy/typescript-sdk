# @keploy/playwright

Joins a Playwright suite to keploy's Universal Mocker. `keploy mock record` records the calls each test's browser and app server make; `keploy mock replay` answers them from the recording, so the suite runs without its backends. keploy judges every recorded test, and lists each test it cannot replay with a reason.

This package tells keploy where each test begins and ends. Through it, keploy skips a test it set aside and fails a test whose calls changed. It speaks keploy's scope protocol v1, the same one go-sdk's `keploytest` speaks, and decides nothing itself.

## Use

```sh
npm install --save-dev @keploy/playwright
```

Import `test` and `expect` from this package instead of `@playwright/test`. A fixture file that extends `test` extends this one:

```ts
import { test, expect } from '@keploy/playwright';

test('lists the apps', async ({ page }) => {
  await page.goto('/apps');
  await expect(page.getByRole('row')).toHaveCount(3);
});
```

Run the suite under keploy with one worker:

```sh
keploy mock record -c "npx playwright test --workers=1"
keploy mock replay -c "npx playwright test --workers=1"
```

keploy's first release runs one test process at a time. A second worker that is still alive while another runs is refused by keploy, and its tests fail.

## Without keploy

With `KEPLOY_MOCK_AGENT` unset or `off`, nothing changes. Only `keploy mock record` and `keploy mock replay` set that variable.

## Under keploy

- **Claim.** Each worker claims keploy's run before its first hook or test (`POST /agent/instance`). The claim uses the worker's Playwright project name as its key, or `.` for an unnamed project. A worker that Playwright starts again after a failed test claims again.
- **Begin.** Each test begins (`POST /agent/scope/begin`) before its `beforeEach` hooks. keploy builds the test's ID as `[project::]file::titles`. The file is relative to the project directory keploy names (`KEPLOY_MOCK_PROJECT`). The titles are the describe groups and the test's own title, joined with ` › `.
- **Skip.** When keploy has set a test aside, the test is skipped through Playwright's own skip, and the report shows keploy's reason (`keploy: ...`).
- **Settle.** Before the test's `context` (and its `page`) closes, the test waits until none of its pages' calls is in flight. Calls are counted by the browser's own request events, and no time window decides. A call that never ends keeps the test waiting until Playwright's test timeout fails it. The test shows a step that names each call still in flight. A call is not waited for once the browser has cancelled it, which happens when its page loads another document, its frame is removed or its page closes. A route change inside the page (the history API) cancels nothing.
- **End.** The test ends (`POST /agent/scope/end`) after its last teardown, with its own outcome. When keploy saw a call with no recorded answer, or a recorded call the test no longer made, the test fails with keploy's text.
- **Given values.** `await given(name, value)` tells keploy a value the test made itself. Examples are a session token it signs and a name it stamps with the time. keploy then follows the value wherever the test's calls carry it, as it follows an incoming request's values in a server test. Give a distinctive value, whole, as the calls carry it. `given` must be called inside a test, or in its `beforeEach` or `afterEach` hooks. It returns the value.

Any answer from the agent that this package cannot trust fails the test. That covers an agent it cannot reach, an error answer, an unreadable answer, and an answer that does not speak scope protocol v1. Nothing is retried.

## Limits of this version

- Settle covers the `context` and `page` fixtures. A context the test makes with `browser.newContext()` is the test's own to close.
- Calls that `beforeAll`/`afterAll` hooks and worker fixtures make outside every test are answered from the worker's claim, one slice per Playwright project.
