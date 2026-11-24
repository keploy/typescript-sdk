# @keploy/coverage

Per-test code coverage of a Node.js app for `keploy test --dedup` and keploy's code coverage reports. It runs
inside the app's own process, measures it with V8's precise block coverage, maps TypeScript back through
source maps, and answers keploy's agent on the app's coverage control socket. No change to the app's code,
no runtime dependency, Node 18 or later.

## Use

The package is not on npm yet: use it from a checkout of this repo, by the absolute path of `register.js`. Put
it **first** in `NODE_OPTIONS`, before any preload of your own:

```sh
git clone https://github.com/keploy/typescript-sdk
NODE_OPTIONS="--require $PWD/typescript-sdk/coverage/register.js $NODE_OPTIONS" \
  keploy test -c "node dist/main.js" --dedup
```

A preload of yours that comes before it (an APM's `instrument.js`) is compiled before V8's precise coverage
starts. Its files are then held `not_measured`, with that reason, and everything else is measured. Requiring
the adapter twice (two paths, two copies) starts one adapter.

## What it measures

- **The app's process only.** It starts in the main thread of a process whose main script is under the app's
  root and not under `node_modules`. `npm start`, `npx`, `nodemon` and other tools that start the app get the
  same `NODE_OPTIONS` but are not measured; the `node` process they start is. `KEPLOY_COVERAGE=0` turns it off.
  `KEPLOY_COVERAGE=all` measures any process. With `all`, a tool's own process (`npm start`'s) binds the socket
  first and the app is not measured, so use it only for an app that starts itself.
- **The app's files.** These are the `.js`, `.cjs` and `.mjs` files under the root (`KEPLOY_APP_SOURCE_DIR`, else
  the working directory). It leaves out:
  - `node_modules`, `__tests__`, hidden dirs, and the root's own `coverage/`;
  - test files (`*.test.*`, `*.spec.*`), the root's tool configs (`jest.config.js`) and `*.min.js`;
  - the globs in `KEPLOY_COVERAGE_EXCLUDE` (comma-separated; `*`, `**`, `?`; a glob with no `/` also matches a
    file's base name).
- **Source maps.**
  - A compiled file with a source map counts for its original sources inside the root, such as `src/orders.ts`.
    The map may be a file next to it, inline, an index map, or name `webpack://` sources.
  - Every mapping segment is a point V8 can count, so one-line and wrapped bundles credit each original line on
    its own.
  - When a source is not on disk, the map's `sourcesContent` is used. When neither has it, or the map is stale
    (its `sourcesContent` differs from the file, or it points past the source's end), the compiled file is
    measured as itself. This is said on stderr.
- **Lines.** A line is code when it holds something other than comments, blanks and brackets. A test ran a line
  when V8's innermost block that holds one of the line's points ran during the test's window. The table groups
  lines into functions and methods by a small static reading of the source. A wrong guess there only moves a line
  between methods; it never changes whether the line ran.

## How keploy talks to it

keploy's agent sends one command per connection on `/tmp/coverage_control.sock`, and gets one line back:
`ACK proto=2` when the command was taken, or `IGNORED proto=2 <why>` when it was not.

- `START <set>/<case>` opens the test's window: V8's counts are taken and dropped, which resets them. A START
  while another window is open replaces that window, and the replaced test sends nothing.
- `END <set>/<case>` takes the window's counts once queued callbacks have run. It then sends
  `{"id":"<set>/<case>","executedLinesByFile":{"src/orders.ts":[12,13]}}` on `/tmp/coverage_data.sock`.
- `TABLE` streams the build table as KTB1 frames: the `table` part, one file per line, then an empty `probes`
  part. Every line is a leaf, so keploy needs no probe map.

The first START on each new data socket also sends an INDEX record (`{"kind":"index","language":"node",
"build":"js1-…",…}`). The build id names:
- every measured file's path and bytes;
- every compiled file and its map's bytes;
- the table format, the adapter's version and the Node major.minor.

The table is made once the app's main module has run, a file at a time between the app's own events.

The control socket is bound before the app's first module loads.
- A socket that a live process serves is never taken over. This process says so and marks itself a peer
  (`<socket>.peers/<pid>`), and it keeps precise coverage on. It binds once that path is gone or stale, and is
  then measured as if it had owned the socket from its start.
- A stale socket is replaced.
- A path there that is not a socket is never removed.

## When it cannot measure, it says so

What it cannot measure, it never sends as lines. keploy shows the reason, and the test is kept.

| Case | What keploy gets |
|---|---|
| The root is `/` or a system dir (no `KEPLOY_APP_SOURCE_DIR`) | every START `IGNORED` with the reason; INDEX with no build |
| `NODE_V8_COVERAGE` is set (c8): taking counts would corrupt its report | the same |
| TypeScript or Babel compiled in memory (`ts-node`, `tsx`, `@swc-node`, `@babel/register`), or Node's own TypeScript (`node src/main.ts`) | the same: run the compiled JS with its source maps |
| A CommonJS file V8 ran as other bytes than the table read (a load-time transform or a patched `Module.wrap`, by the sha256 of the source V8 compiled), or an ES module whose top-level range V8 reports with another length | `classMismatch` names it in the test's record; none of its lines are sent |
| An ES module loader hook exists (`module.register`, `module.registerHooks`, `--loader`), and V8 did not report a root ES module's length | `classMismatch` names the module |
| A request was still being answered when the window ended, or when it began (a request keploy stopped waiting for) | the record has `windowCut` |
| A file the table holds `not_measured` ran during the test (except a root preload that came first) | `classMismatch` names it |
| A script under the root that the table does not hold ran (`.js/.cjs/.mjs/.ts/.mts/.cts/.tsx/.jsx`, or the main script; a template's `sourceURL` such as `views/x.ejs` is none) | the record has `windowCut`; the script is named once on stderr |
| A worker thread, whatever it runs (a root file, an `eval` string, a pool library, a logger's transport), lived during the test | END `IGNORED` with the reason. An app that keeps a worker for its life (pino transports) gets every test IGNORED. |
| The app serves from cluster workers (a primary with workers) | END `IGNORED` with the reason |
| Another process of the app (a fork, a spawned `node`, a queue worker, a cluster worker) is alive during the test, or started during it, even if it exited before END | END `IGNORED`: the app serves requests in other processes. Each process of the app marks itself at its preload in `<socket>.peers-<uid>/<pid>`. A process whose main script is outside the root (a Bull or BullMQ sandboxed processor forked from `node_modules`, `node -e`) marks itself when it first compiles a file of the app. It finds the app's root in `KEPLOY_COVERAGE_ROOT`, which the measured process sets for the processes it starts. |
| The peers dir is not this user's own `0700` dir | END `IGNORED` with the reason: no other process can be told apart |
| Another inspector client turned V8's precise coverage off | the record has `windowCut` |
| A root file loaded before this preload | the file is a `not_measured` unit of the table |
| A file read as two texts while the table was made | the same |
| A minified file with no map, a map of no app file, a file that cannot be read | the same |
| A file whose name holds a backslash or a control character | left out of the table, said on stderr |

No decision reads a clock: under `KEPLOY_PROVEN` keploy sets the app's clock back to the recording's time.

### Not detected

These are the cases where lines can be missing or wrong with nothing marked:

- **Timers and queue consumers in the measured process.** A `setTimeout`, a `setInterval` job or an in-process
  queue consumer that fires during a window counts for that test. One that the test started but that runs after
  END counts for a later window, or none. Requests in flight are detected (see above); timers and queues are not.
  This needs a decision before it is a stated limit.
- **A stale source map with no `sourcesContent` (tsc's default) whose positions still fit the edited source.**
  Old generated lines are credited to the new source's line numbers. This is the one remaining silent case of
  the table. Build with `inlineSources`, or rebuild, so the map carries its sources: then a stale map is
  measured as the generated file itself.
- **A root preload that came before keploy's.** Its files are held `not_measured`. A test that ran their code
  (an APM's per-request callback) is sent without those lines, so the tests lack the preload's lines.
- **A process of the app running as another user.** It marks itself in its own `peers-<uid>` dir, which the
  owner does not read. Forked children keep their user, so this is rare.
- **An ES module compiled in a process whose main script is outside the root.** Only CommonJS compiles are seen
  there, so such a process is not marked.
