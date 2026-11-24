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
| Another process of the app (a fork, a spawned `node`, a queue worker, a cluster worker) is alive during the test, or started during it, even if it exited before END | END `IGNORED`: the app serves requests in other processes. Each process of the app marks itself at its preload in `<socket>.peers/<pid>`, a dir shared by every user (1777, sticky), so a process running as another user marks itself too. A process whose main script is outside the root (a Bull or BullMQ sandboxed processor forked from `node_modules`, `node -e`) marks itself when it first compiles a CommonJS file of the app, or loads an ES module of it (a load hook: `module.registerHooks`, else `module.register`; on a Node with neither, at its preload whenever the app holds ES modules). It finds the app's root in `KEPLOY_COVERAGE_ROOT`, which the measured process sets for the processes it starts. A mark planted by anyone only makes the owner answer `IGNORED`, never send other lines. |
| The peers dir is not a real shared sticky dir (1777) owned by root or this user (it is made race-free; marks are written with `O_EXCL`, never through a link) | END `IGNORED` with the reason: no other process can be told apart |
| App code ran in work that is not the test's, in its window: a timer set before the test, a queue consumer, a watcher, a callback-style driver that calls the app inside its socket's callback, another client's request. Every callback that is not the test's own is bracketed by two takes of V8's counts; an app line in that delta is never credited. A driver in `node_modules` that resolves the handler's promise (pg, mysql2, mongodb, undici, a pooled socket) runs no app line there, so it is no partial. | the record has `partial`, naming the kind of work and the file |
| More than one request ran in the test's window (keploy sends one) | the record has `partial` |
| Node 18 (end of life) | every record has `partial` with the reason |
| Work the test's requests started was still running at END, after END waits up to 50 ms for it with the measuring still on: a ref'd timer or immediate still due, an interval still running, a request in flight (fs, DNS, connect, write, a crypto job), a child process. Work that finishes within the wait is measured in the window, as the test's. A promise is never judged at END. | the record has `partial` with the reason |
| Work the test started ran app code after its end: a promise's continuation (a reply on a pooled socket after the response), a callback driver's reply, a socket it opened, an unref'd or refreshed timer, any callback whose chain began in its window, and any work between windows | the test is amended: keploy gets `{"kind":"amend","v":1,"test","partial"}` (the test's id under `test`, never `id`) after its record, and holds it partial. Those lines are no test's. |
| A process of the app that was alive at START is gone at END | the record has `partial` |
| A preload of the app's that came before keploy's ran in the test | the record has `partial` |
| Another inspector client turned V8's precise coverage off | the record has `windowCut` |
| A root file loaded before this preload | the file is a `not_measured` unit of the table; a test that ran it is `partial` |
| A file read as two texts while the table was made | the same |
| A minified file with no map, a map of no app file, a file that cannot be read | the same |
| A source map whose source is missing, stale (its `sourcesContent` differs, it points past the source's end), or that has no `sourcesContent` and is not verified exactly: every mapped place where the generated code and the source both hold a name the source has must hold the same name, at least 5 of them | the file is not mapped: the generated file is measured as itself, said on stderr |
| A file whose name holds a backslash or a control character | left out of the table, said on stderr |

No decision reads a clock: under `KEPLOY_PROVEN` keploy sets the app's clock back to the recording's time.

### How the test's own work is told apart

- The test's request, its socket and HTTP parser, and the `'connection'` callbacks of an HTTP server that accepts a
  connection in the window before its first request (keploy opens one per test) are the test's.
- Everything those make (timers, promises, requests, sockets) is the test's too.
- Scopes nest: a library's callback run inside the test's code, or the test's run inside a library's, is measured
  as its own kind, and the code around it as the outer kind.
- A launcher in `node_modules` (pm2-runtime and the like) that reads the root's config (`ecosystem.config.js`, by
  `require` or `import`) is not one of the app's processes: config files are not app code.

### The limits that remain, and why each cannot be seen

- **Node 18** (end of life): there is no async tracking (its async hooks with the in-hook takes did not stay
  bounded), so every test's record is `partial` ("Node 18 … is end of life: keploy cannot tell its async work
  apart; use Node 20+"). Lines are still sent; none is credited as whole.
- **Work that is not the test's but runs no app line** (a driver's heartbeat, a library's own timer) is not
  flagged. It changes no line of the app's, so the test's lines are whole. There is nothing to see.
- **Names a compiler made** (`exports`, `svc_1`, `__decorate`: names the source does not hold) are not checked by
  the exact source map check. There is no source name to compare them with. A map whose only change is a rename
  of every use of a name still maps, and its lines are still right: names moved, code did not.
- **Node's own timers** are told apart by identity (a socket's idle timeout, marked when `net` sets it) or are
  unref'd (the HTTP Date cache, the HTTP server's connection check), which pending never counts. An app timer is
  the app's whatever its name.
- **Cost:** each switch between the test's work and other work in its window costs one take of V8's counts, which
  V8 has to collect over every function it holds. Measured on a box: 0.56-0.65 ms a take on Node 24 and
  0.74-0.75 ms on Node 22 on a small app; 0.88-1.03 ms and 1.13-1.15 ms on a mid-size one (300 files, 6000
  functions loaded). A round trip on a pooled DB socket switches twice: 1.5-2.3 ms on Node 24 and 2.0-2.7 ms on
  Node 22. A take that does not answer at once cuts the window
  (`windowCut`); V8's takes answer at once on Node 20, 22 and 24.
- **Worker threads** of any kind make the test `IGNORED`. Their code runs in another isolate, which this session's
  counts do not see.

The `--require` order: keploy's preload must come first in `NODE_OPTIONS` (`--require …/register.js
$NODE_OPTIONS`). A preload before it is held `not_measured`, and the tests that run it are `partial`.

## What each record carries

- A test's record: `{"id","pid","build","executedLinesByFile","fileHashes"}`. It may also carry `classMismatch`,
  `windowCut`, and `partial` (why the window holds work that is not the test's). `fileHashes` names the unit hash
  of each file the record names: the bytes this process ran, as checked against the table.
- The STARTUP record, once per process, before the ACK of its first START:
  `{"kind":"startup","v":1,"pid","build","executedLinesByFile","fileHashes"}`. It holds the lines the process ran
  before its first window (its import, the app's start), which keploy never credits to a test.
