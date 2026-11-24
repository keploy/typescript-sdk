'use strict';
// Preload: node --require @keploy/coverage/register (or the absolute path of
// this file, appended to NODE_OPTIONS). It starts keploy's coverage adapter
// in the app's process, once, however often it is required, and only in the
// app: the main thread of a process whose main script is under the app's
// root (KEPLOY_APP_SOURCE_DIR, else the working directory), not under
// node_modules. KEPLOY_COVERAGE=0 turns it off; KEPLOY_COVERAGE=all
// measures any process. Nothing here throws into the app.
//
// What it cannot measure it says, and keploy shows: the adapter then binds
// the control socket all the same and answers every START IGNORED with the
// reason (a root of / or a system dir, NODE_V8_COVERAGE set, TypeScript
// compiled in memory).

const KEY = Symbol.for('keploy.coverage.agent');

function start() {
  if (globalThis[KEY]) return globalThis[KEY];
  const env = process.env;
  const mode = (env.KEPLOY_COVERAGE || '').toLowerCase();
  globalThis[KEY] = { started: false };
  if (mode === '0' || mode === 'off' || mode === 'false') return globalThis[KEY];
  const { isMainThread } = require('worker_threads');
  if (!isMainThread) return globalThis[KEY];
  const fs = require('fs');
  const path = require('path');
  const { Agent, mainInRoot, mainScript, writePeerMark, SYSTEM_DIRS } = require('./lib/agent');
  let root;
  try {
    // KEPLOY_COVERAGE_ROOT: set by the measured process for the processes
    // it starts, so their working directory never decides the root.
    root = fs.realpathSync(path.resolve(env.KEPLOY_APP_SOURCE_DIR || env.KEPLOY_COVERAGE_ROOT || process.cwd()));
  } catch (e) {
    process.stderr.write(`[keploy coverage] no app root to measure: ${e.message}\n`);
    return globalThis[KEY];
  }
  const main = mainScript();
  const control = env.KEPLOY_COVERAGE_CONTROL_SOCKET || '/tmp/coverage_control.sock';
  if (mode !== 'all' && !mainInRoot(root, main)) {
    // Not the app's own process (a queue's sandboxed processor forked from
    // node_modules, node -e): it is not measured, but once it compiles a
    // file of the app it marks itself, synchronously, before that code
    // runs, so the measured process fails closed on the tests it ran in.
    markOnRootCompile(root, control, writePeerMark);
    markOnRootImport(root, control, writePeerMark);
    return globalThis[KEY];
  }
  let disabled = '';
  if (!env.KEPLOY_APP_SOURCE_DIR && SYSTEM_DIRS.has(root)) {
    disabled = `the app's root would be ${root} (the working directory): set KEPLOY_APP_SOURCE_DIR to the app's folder`;
  } else if (env.NODE_V8_COVERAGE) {
    disabled = 'NODE_V8_COVERAGE is set (c8): keploy would reset the counts it reports; unset it for per-test coverage';
  }
  // Root files already loaded (another --require that came first, such as
  // an APM's instrument.js) were compiled before V8's precise coverage: the
  // table holds them not measured, with the reason.
  const held = new Set();
  for (const f of Object.keys(require.cache)) {
    const rel = path.relative(root, f);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules') &&
      !f.startsWith(__dirname + path.sep)) held.add(f);
  }
  const agent = new Agent({
    root,
    env,
    main,
    disabled,
    held,
    control,
    data: env.KEPLOY_COVERAGE_DATA_SOCKET || '/tmp/coverage_data.sock',
  });
  globalThis[KEY] = { started: true, agent };
  // Processes the app starts (a queue's sandboxed processor, node -e) read
  // the app's root from here, whatever their working directory.
  process.env.KEPLOY_COVERAGE_ROOT = root;
  if (disabled) process.stderr.write(`[keploy coverage] not measured: ${disabled}\n`);
  // Before the app's first module: every app function is counted from its
  // first compile, and every CommonJS source V8 compiles is seen.
  try {
    agent.startProfiler();
  } catch (e) {
    agent.disabled = `V8 precise coverage could not start: ${e.message}`;
    process.stderr.write(`[keploy coverage] ${agent.disabled}\n`);
  }
  agent.hookCompile();
  agent.hookWorkers();
  agent.hookLoaders();
  agent.hookAsync();
  agent.hookRequests();
  // Marked now, before the socket is tried: a process that does its work
  // and exits before it learns it is no owner still shows to the owner.
  agent.markPeer();
  agent.own(() => agent.listen((owner) => {
    // The table is made once this process owns the socket, after the
    // app's main module has run, a file at a time between the app's events.
    if (owner && !agent.disabled) agent.makeTable();
  }));
  process.on('exit', () => agent.close());
  return globalThis[KEY];
}

function markOnRootCompile(root, control, writePeerMark) {
  const path = require('path');
  const Module = require('module');
  const orig = Module.prototype._compile;
  if (typeof orig !== 'function' || orig.__keployCoverageMark) return;
  let marked = false;
  // A file the table never counts (a test file a runner compiles, a tool's
  // config) does not make the process one of the app's.
  const { excluder, skippedPath } = require('./lib/table');
  const excluded = excluder(process.env);
  const isTooling = (rel) => excluded(rel) || skippedPath(rel);
  const hooked = function (content, filename) {
    try {
      if (!marked && typeof filename === 'string') {
        const rel = path.relative(root, filename);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules') &&
          !isTooling(rel.split(path.sep).join('/'))) {
          marked = true;
          writePeerMark(control);
        }
      }
    } catch {
      // never in the app's way
    }
    return orig.apply(this, arguments);
  };
  hooked.__keployCoverageMark = true;
  Module.prototype._compile = hooked;
}

// markOnRootImport marks a process that is not measured when it first loads
// an ES module of the app (an .mjs, a "type": "module" package anywhere, a
// .js Node reads as ESM by its syntax): by a load hook, which sees every
// load (module.registerHooks in the thread, else module.register), or, on a
// Node with neither, at once (fail closed).
function markOnRootImport(root, control, writePeerMark) {
  const Module = require('module');
  const path = require('path');
  const { fileURLToPath } = require('url');
  let marked = false;
  const isApp = (url) => {
    if (typeof url !== 'string' || !url.startsWith('file:')) return false;
    let f;
    try { f = fileURLToPath(url); } catch { return false; }
    const rel = path.relative(root, f);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules')) return false;
    // The same files the CommonJS path counts: no test file, no tool's.
    return !isTooling(rel.split(path.sep).join('/'));
  };
  const { excluder, skippedPath } = require('./lib/table');
  const excluded = excluder(process.env);
  const isTooling = (rel) => excluded(rel) || skippedPath(rel);
  try {
    if (typeof Module.registerHooks === 'function') {
      Module.registerHooks({
        load(url, context, nextLoad) {
          if (!marked && isApp(url)) { marked = true; writePeerMark(control); }
          return nextLoad(url, context);
        },
      });
      return;
    }
    if (typeof Module.register === 'function') {
      const dir = `${control}.peers`;
      // The hook runs on Node's loader thread: it writes this process's mark
      // itself, the first time it loads an app file.
      const hook = [
        "import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';",
        'let root = ""; let dir = ""; let done = false;',
        'let excl = [];',
        'export function initialize(d) { root = d.root; dir = d.dir; excl = d.excl.map((x) => new RegExp(x)); }',
        'export async function load(url, context, next) {',
        '  if (!done && url.startsWith("file:")) {',
        '    try {',
        '      const rel = path.relative(root, fileURLToPath(url));',
        '      const parts = rel.split(path.sep); const r = parts.join("/"); const base = parts[parts.length - 1];',
        '      const tooling = /\\.(test|spec)\\.[^.]+$/.test(base) || /\\.min\\.js$/.test(base) || (parts.length === 1 && /\\.config\\.[^.]+$/.test(base)) ||',
        '        parts[0] === "coverage" || parts.some((x) => x.startsWith(".") || x === "node_modules" || x === "__tests__") || excl.some((e) => e.test(r) || e.test(base));',
        '      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !tooling) {',
        '        done = true;',
        '        const c = fs.constants; fs.closeSync(fs.openSync(path.join(dir, String(process.pid)), c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o644));',
        '      }',
        '    } catch {}',
        '  }',
        '  return next(url, context);',
        '}',
      ].join('\n');
      // The dir and its trust are this thread's: a mark written there is checked by the owner.
      const ag = require('./lib/agent');
      ag.makePeersDir(dir);
      // The loader thread writes the mark with O_EXCL|O_NOFOLLOW; the dir's
      // owner and mode are checked here first: an untrusted dir gets no
      // mark (the owner fails closed on it anyway).
      if (ag.untrusted(dir)) { writePeerMark(control); return; }
      const { globRe } = require('./lib/table');
      const excl = (process.env.KEPLOY_COVERAGE_EXCLUDE || '').split(',').map((g) => g.trim()).filter(Boolean).map((g) => globRe(g).source);
      Module.register('data:text/javascript,' + encodeURIComponent(hook), { data: { root, dir, excl } });
      return;
    }
  } catch {
    // no hook: marked below
  }
  writePeerMark(control);
}

try {
  module.exports = start();
} catch (e) {
  process.stderr.write(`[keploy coverage] did not start: ${e && e.message}\n`);
}
