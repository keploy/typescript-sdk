'use strict';
// The adapter in the app's process: it measures the app with V8's precise
// block coverage (an inspector session of its own) and answers keploy's
// commands on the app's control socket, as keploy-sdk 2.2.0 does for Java:
//
//   START <set>/<case>  opens the test's window (V8's counts are taken and
//                       dropped, which resets them)
//   END <set>/<case>    takes the window's counts, maps them to lines and
//                       sends the test's record on keploy's data socket
//   TABLE               streams the build table (KTB1 frames)
//
// Every command gets one line back: "ACK proto=2" when taken, else
// "IGNORED proto=2 <why>". An INDEX record names the build once per data
// socket (each new keploy receiver binds a new one).
//
// It fails closed: what it cannot measure is never sent as lines. A whole
// app it cannot measure answers every START IGNORED with the reason (and
// its INDEX names no build and says why in launch); a test whose window it
// cannot trust is IGNORED or cut (windowCut); a script V8 ran that is not
// the bytes the table read is named in classMismatch.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const inspector = require('inspector');
const Module = require('module');
const { fileURLToPath } = require('url');
const table = require('./table');
const { hitEntries } = require('./v8lines');

const SDK_VERSION = require('../package.json').version;
const ACK = 'ACK proto=2\n';
const ignored = (why) => `IGNORED proto=2 ${String(why).replace(/[\r\n]+/g, ' ')}\n`;
// A frame is its 8-byte prefix and a body of at most 1 MiB - 8 (keploy's
// maxTableFrame); a payload of 512 KiB leaves room for the header line.
const FRAME_PAYLOAD = 512 << 10;
const SEND_TIMEOUT_MS = 5000;
const FRAME_TIMEOUT_MS = 30000;
const INDEX_TIMEOUT_MS = 2000;
// How long a START waits for the build table, made after the app starts.
const TABLE_WAIT_MS = 10000;
const COMMAND_IDLE_MS = 10000;
const OWNER_RETRY_MS = 500;
// Roots a walk never covers: the app's root defaults to the working
// directory, which is / in an image with no WORKDIR.
const SYSTEM_DIRS = new Set(['/', '/usr', '/bin', '/sbin', '/etc', '/lib', '/lib64', '/proc', '/sys', '/dev', '/var', '/tmp', '/root', '/home', '/opt', '/boot', '/run', '/srv', '/mnt']);
// Tools that compile the app's code in memory as it loads: V8 then runs
// code no file under the root holds.
const LOAD_COMPILERS = /(^|[/@\s=])(ts-node|tsx|@swc-node|@swc\/register|esbuild-register|@esbuild-kit|sucrase|@babel\/register|babel-register)([/\s]|$)/;

function say(msg) {
  try {
    process.stderr.write(`[keploy coverage] ${msg}\n`);
  } catch {
    // stderr gone: nothing to say it on.
  }
}

function debug(msg) {
  if (process.env.KEPLOY_COVERAGE_DEBUG) say(msg);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * sendOnce(sockPath, data, timeoutMs, waitLine) -> Promise: one connection
 * to keploy's data socket that writes data; with waitLine, it waits for the
 * answer line and resolves with it, else it ends the connection and
 * resolves once keploy closes it. Neither holds the app's exit.
 */
function sendOnce(sockPath, data, timeoutMs, waitLine) {
  return new Promise((resolve, reject) => {
    let done = false;
    let answer = '';
    const s = net.createConnection(sockPath);
    s.unref();
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      s.destroy();
      if (err) reject(err); else resolve(value);
    };
    const t = setTimeout(() => finish(new Error(`no answer from ${sockPath} in ${timeoutMs} ms`)), timeoutMs);
    t.unref();
    s.on('error', (e) => finish(e));
    s.on('connect', () => {
      if (waitLine) s.write(data); else s.end(data);
    });
    s.on('data', (b) => {
      answer += b.toString('latin1');
      const nl = answer.indexOf('\n');
      if (waitLine && nl >= 0) finish(null, answer.slice(0, nl));
    });
    s.on('close', () => {
      if (waitLine) finish(new Error(`${sockPath} closed with no answer`));
      else finish(null, '');
    });
  });
}

/**
 * frame(part, build, payload, seq, last, total) -> one KTB1 frame: "KTB1",
 * the body's length (uint32 BE), then the body: a JSON header line and the
 * next bytes of the stream. The last frame's header names the stream's
 * record count (its newlines) and sha256 (total = {records, sha256}).
 */
function frame(part, build, chunk, seq, last, total) {
  const head = { v: 1, part, build, seq, last };
  if (last) Object.assign(head, total);
  const body = Buffer.concat([Buffer.from(JSON.stringify(head) + '\n', 'utf8'), chunk]);
  const prefix = Buffer.alloc(8);
  prefix.write('KTB1', 0, 'latin1');
  prefix.writeUInt32BE(body.length, 4);
  return Buffer.concat([prefix, body]);
}

// streamTotal(payload) -> {records, sha256} of a part's stream.
function streamTotal(payload) {
  let records = 0;
  for (let i = payload.indexOf(0x0a); i >= 0; i = payload.indexOf(0x0a, i + 1)) records++;
  return { records, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
}

/**
 * frames(part, build, payload) -> every frame of one part's stream (an
 * empty stream is one frame). The adapter cuts them one at a time
 * (streamTable); this is for tests.
 */
function frames(part, build, payload) {
  const total = streamTotal(payload);
  const out = [];
  let seq = 0;
  let off = 0;
  do {
    const chunk = payload.subarray(off, off + FRAME_PAYLOAD);
    off += chunk.length;
    out.push(frame(part, build, chunk, seq++, off >= payload.length, total));
  } while (off < payload.length);
  return out;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// peersDirOf(control) -> the per-user peers dir of a control socket.
function peersDirOf(control) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return `${control}.peers-${uid}`;
}

// untrusted(dir) -> "" when dir is this user's own 0700 dir (or absent).
function untrusted(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return '';
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o777) !== 0o700) {
    return `${dir} is not this user's own 0700 dir, so keploy cannot tell whether other processes of the app run`;
  }
  return '';
}

// writePeerMark(control) -> the mark this process wrote in the peers dir
// (synchronously), or "" when it could not, said on stderr.
function writePeerMark(control) {
  const dir = peersDirOf(control);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch {
    // there already
  }
  const why = untrusted(dir);
  if (why) {
    say(`${why}: this process (pid ${process.pid}) cannot mark itself`);
    return '';
  }
  try {
    const f = path.join(dir, String(process.pid));
    fs.writeFileSync(f, '', { flag: 'w', mode: 0o600 });
    return f;
  } catch (e) {
    say(`could not mark this process (pid ${process.pid}) as one of the app's: ${e.message}`);
    return '';
  }
}

function isSocketPath(p) {
  try {
    return fs.lstatSync(p).isSocket();
  } catch {
    return false;
  }
}

class Agent {
  constructor(opts) {
    this.root = opts.root;
    this.control = opts.control;
    this.data = opts.data;
    this.env = opts.env;
    this.main = opts.main || '';
    this.disabled = opts.disabled || '';
    this.window = null;
    this.queue = Promise.resolve();
    this.table = null;
    this.tableErr = null;
    this.tablePromise = null;
    this.indexKey = '';
    this.streaming = false;
    this.server = null;
    this.ownIno = 0;
    this.owner = false;
    this.session = null;
    this.profiling = false;
    this.compiled = new Map(); // filename -> sha256 of the source V8 compiled
    this.patchedWrap = new Set(); // filenames compiled under a patched Module.wrap
    this.workers = new Set(); // live worker threads, whatever they run
    this.workersInWindow = 0;
    this.bom = new Set(); // CommonJS files V8 compiled with their BOM (offsets one later)
    this.held = opts.held || new Set(); // root files compiled before this preload
    this.tsSeen = ''; // a root TypeScript file Node compiled itself
    this.peerMark = '';
    this.esmHooks = ''; // why ES modules may run other bytes than their files
    this.inFlight = 0; // HTTP requests the app has not finished answering
    this.windowStartedBusy = false;
    this.saidOnce = new Set();
  }

  once(key, msg) {
    if (this.saidOnce.has(key)) return;
    this.saidOnce.add(key);
    say(msg);
  }

  // post(method, params) -> Promise of the inspector's answer.
  post(method, params) {
    return new Promise((resolve, reject) => {
      this.session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  startProfiler() {
    if (this.disabled || this.profiling) return;
    if (!this.session) {
      this.session = new inspector.Session();
      this.session.connect();
    }
    this.profiling = true;
    // Posted before any app module loads: every app function is counted
    // from its first compile.
    this.session.post('Profiler.enable');
    this.session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true }, (err) => {
      if (err) {
        this.profiling = false;
        this.disabled = this.disabled || `V8 precise coverage could not start: ${err.message}`;
        say(this.disabled);
      }
    });
    if (inspector.url()) say(`an inspector is open (${inspector.url()}): a debugger that stops the Profiler cuts the tests' windows`);
  }

  // hookCompile records the sha256 of every CommonJS source V8 compiles
  // (after any load-time transform: a require hook calls _compile with the
  // code it made) and whether Module.wrap was patched (a textual wrapper
  // shifts every offset).
  hookCompile() {
    const proto = Module.prototype;
    const orig = proto._compile;
    if (typeof orig !== 'function' || orig.__keployCoverage) return;
    const agent = this;
    const wrap0 = Module.wrap;
    const wrapper0 = Module.wrapper;
    const wrapperText = String(Module.wrapper);
    const hooked = function (content, filename) {
      try {
        if (typeof content === 'string' && typeof filename === 'string' && agent.inRoot(filename)) {
          // CommonJS keeps a BOM: V8's offsets are then one past the table's.
          const bom = content.charCodeAt(0) === 0xfeff;
          if (bom) agent.bom.add(filename); else agent.bom.delete(filename);
          agent.compiled.set(filename, sha256(bom ? content.slice(1) : content));
          if (Module.wrap !== wrap0 || Module.wrapper !== wrapper0 || String(Module.wrapper) !== wrapperText) agent.patchedWrap.add(filename);
          if (/\.[cm]?tsx?$/.test(filename) && !agent.tsSeen) agent.tsSeen = filename;
        }
      } catch {
        // never in the app's way
      }
      return orig.apply(this, arguments);
    };
    hooked.__keployCoverage = true;
    proto._compile = hooked;
  }

  // hookWorkers tracks every worker thread, whatever it runs (a root file,
  // an eval string, a pool library's script): code a worker runs is not
  // measured, so a window a worker lives in is not the test's whole.
  hookWorkers() {
    let wt;
    try {
      wt = require('worker_threads');
    } catch {
      return;
    }
    const Orig = wt.Worker;
    if (!Orig || Orig.__keployCoverage) return;
    const agent = this;
    class Worker extends Orig {
      constructor(...args) {
        super(...args);
        try {
          agent.workers.add(this);
          agent.workersInWindow++;
          this.once('exit', () => agent.workers.delete(this));
        } catch {
          // never in the app's way
        }
      }
    }
    Worker.__keployCoverage = true;
    wt.Worker = Worker;
    try {
      Module.syncBuiltinESMExports();
    } catch {
      // ESM imports of worker_threads keep the original
    }
  }

  // hookLoaders notes an ES module loader hook: one registered by
  // module.register / module.registerHooks, or named by --loader.
  hookLoaders() {
    const args = [...process.execArgv, ...(this.env.NODE_OPTIONS || '').split(/\s+/)];
    const i = args.findIndex((a) => /^--(experimental-)?loader(=|$)/.test(a));
    if (i >= 0) this.esmHooks = `an ES module loader is set (${args[i]}${args[i].includes('=') ? '' : ' ' + (args[i + 1] || '')})`;
    for (const name of ['register', 'registerHooks']) {
      const orig = Module[name];
      if (typeof orig !== 'function' || orig.__keployCoverage) continue;
      const agent = this;
      const wrapped = function (...a) {
        if (!agent.esmHooks) agent.esmHooks = `an ES module loader hook is registered (module.${name})`;
        return orig.apply(this, a);
      };
      wrapped.__keployCoverage = true;
      try { Module[name] = wrapped; } catch { /* read-only: left as it is */ }
    }
  }

  // hookRequests counts the HTTP requests the app is answering.
  hookRequests() {
    let dc;
    try {
      dc = require('diagnostics_channel');
    } catch {
      return;
    }
    if (typeof dc.subscribe !== 'function') return;
    try {
      dc.subscribe('http.server.request.start', () => { this.inFlight++; });
      dc.subscribe('http.server.response.finish', () => { this.inFlight = Math.max(0, this.inFlight - 1); });
    } catch {
      // an older Node: no request count
    }
  }

  // inRoot(abs) -> whether abs is a file under the app's root, not under
  // node_modules.
  inRoot(abs) {
    const rel = path.relative(this.root, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules');
  }

  runtime() {
    const [maj, min] = process.versions.node.split('.');
    return `node ${maj}.${min}`;
  }

  // loadCompiler -> why the app's code is compiled in memory as it loads
  // (ts-node, tsx, babel), or "".
  loadCompiler() {
    const nodeTS = process.features && process.features.typescript;
    if (nodeTS && (/\.[cm]?tsx?$/.test(this.main) || this.tsSeen)) {
      return `Node's built-in TypeScript is not measured yet (${path.relative(this.root, this.tsSeen || this.main)}): run the compiled JS with its source maps`;
    }
    const ext = Object.keys(require.extensions || {}).find((e) => ['.ts', '.tsx', '.mts', '.cts'].includes(e));
    if (ext) return `a require hook compiles ${ext} files in memory (ts-node, tsx): run the compiled JS with its source maps`;
    const args = [...process.execArgv, ...(this.env.NODE_OPTIONS || '').split(/\s+/)].join(' ');
    const m = LOAD_COMPILERS.exec(args);
    if (m) return `the app runs under ${m[2]}, which compiles its code in memory: run the compiled JS with its source maps`;
    return '';
  }

  // makeTable builds the table once, after the app's main module has run,
  // yielding to the app's event loop between files.
  makeTable() {
    if (this.tablePromise) return this.tablePromise;
    const t0 = process.hrtime.bigint();
    const pause = () => new Promise((r) => setImmediate(r));
    this.tablePromise = table.build(this.root, this.env, this.runtime(), SDK_VERSION, pause, { held: this.held, main: this.main }).then((t) => {
      this.table = t;
      if (t.failed.length) {
        say(`not measured: ${t.failed.length} file(s): ${t.failed.slice(0, 5).map((f) => `${f.path} (${f.why})`).join('; ')}${t.failed.length > 5 ? '; ...' : ''}`);
      }
      if (t.notes.length) say(`${t.notes.length} source(s) left out: ${t.notes.slice(0, 3).join('; ')}${t.notes.length > 3 ? '; ...' : ''}`);
      debug(`build ${t.build}: ${t.unitCount} files in ${Number(process.hrtime.bigint() - t0) / 1e6} ms`);
      return t;
    }, (e) => {
      this.tableErr = `the app's build table could not be made: ${e.message}`;
      say(this.tableErr);
      return null;
    });
    return this.tablePromise;
  }

  // awaitTable -> the table, or null when it failed or is not made in ms.
  async awaitTable(ms) {
    let timer;
    const t = await Promise.race([
      this.makeTable(),
      new Promise((r) => { timer = setTimeout(() => r(null), ms); timer.unref(); }),
    ]);
    clearTimeout(timer);
    return t;
  }

  // why -> why the app is not measured now, or "".
  why() {
    if (this.disabled) return this.disabled;
    const c = this.loadCompiler();
    if (c) {
      this.disabled = c;
      say(`not measured: ${c}`);
    }
    return this.disabled;
  }

  index() {
    const t = this.table;
    const why = this.disabled;
    // "kind" is the first key: keploy reads it so. With no build, launch
    // says why the app is not measured.
    return JSON.stringify({
      kind: 'index',
      v: 1,
      language: 'node',
      build: why || !t ? '' : t.build,
      source: why ? 'none' : 'root',
      launch: why || (this.main ? path.relative(this.root, this.main) : ''),
      roots: [this.root],
      rootCount: 1,
      packages: [],
      classes: why || !t ? 0 : t.unitCount,
      includes: '',
      jacoco: '',
      sdkVersion: SDK_VERSION,
      jacocoVersion: '',
      producer: 'v8',
      producerVersion: process.versions.v8,
    });
  }

  // sendIndex sends the INDEX record when keploy's data socket is not the
  // one it was last sent on (a new receiver binds a new socket file).
  async sendIndex() {
    let st;
    try {
      st = fs.statSync(this.data);
    } catch {
      return; // no receiver: nothing to send it to
    }
    const key = `${st.ino}:${st.ctimeMs}:${this.disabled ? 'off' : 'on'}`;
    if (key === this.indexKey) return;
    try {
      await sendOnce(this.data, this.index(), INDEX_TIMEOUT_MS, false);
      this.indexKey = key;
    } catch (e) {
      say(`could not send the INDEX record: ${e.message}`);
    }
  }

  async start(id) {
    if (this.why()) {
      this.window = null;
      await this.sendIndex();
      return ignored(`the app is not measured: ${this.disabled}`);
    }
    const t = await this.awaitTable(TABLE_WAIT_MS);
    if (!t) return ignored(this.tableErr || `the app's build table is still being made (${TABLE_WAIT_MS} ms)`);
    if (this.window !== null && this.window !== id) {
      say(`START ${id} while ${this.window} was open: ${this.window} sends no coverage`);
    }
    this.window = null;
    try {
      await this.post('Profiler.takePreciseCoverage');
    } catch (e) {
      return ignored(`could not reset V8's counts: ${e.message}`);
    }
    this.window = id;
    this.workersInWindow = this.workers.size;
    this.startMarks = this.readMarks(true);
    this.windowStartedBusy = this.inFlight > 0;
    await this.sendIndex();
    return ACK;
  }

  // outside -> why code of this test ran where it is not measured, or "".
  outside() {
    if (this.workersInWindow > 0) {
      return `the app ran ${this.workersInWindow} worker thread(s) during the test, whose code per-test coverage does not measure`;
    }
    let cluster;
    try {
      cluster = require('cluster');
    } catch {
      return '';
    }
    const n = cluster.workers ? Object.keys(cluster.workers).length : 0;
    if ((cluster.isPrimary || cluster.isMaster) && n > 0) {
      return `the app serves from ${n} cluster worker(s), which per-test coverage does not measure: run one process`;
    }
    return '';
  }

  async end(id) {
    if (this.window !== id) {
      return ignored(this.window === null ? `END ${id} with no window open` : `END ${id} while ${this.window} is open`);
    }
    // Callbacks the test's last request queued run first.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    if (this.window !== id) return ignored(`END ${id}: its window was replaced while it settled`);
    this.window = null;
    const record = { id, executedLinesByFile: {} };
    let res;
    try {
      res = await this.post('Profiler.takePreciseCoverage');
    } catch (e) {
      say(`${id}: V8's counts could not be read (${e.message}): its window is cut`);
      record.windowCut = true;
    }
    const out = this.outside();
    if (out) return ignored(out);
    if (res) Object.assign(record, this.lines(res.result));
    if (this.inFlight > 0 || this.windowStartedBusy) {
      // A request still being answered: its work lands across windows.
      record.windowCut = true;
      this.once('inflight', `a test's window ended (or began) while ${this.inFlight || 'a'} request(s) were still being answered: such tests are cut (not measured)`);
    }
    const peers = this.peersInWindow();
    if (peers) return ignored(peers);
    try {
      await sendOnce(this.data, JSON.stringify(record), SEND_TIMEOUT_MS, false);
    } catch (e) {
      return ignored(`could not send ${id}'s coverage: ${e.message}`);
    }
    return ACK;
  }

  // mismatched(abs, g, fns) -> why V8 ran other bytes than the table read
  // for this script, or "".
  mismatched(abs, g, fns) {
    if (this.patchedWrap.has(abs)) return 'Module.wrap was patched';
    const c = this.compiled.get(abs);
    if (c !== undefined) return c === g.textSha ? '' : 'its compiled source differs from the file (a load-time transform, or a file changed after it loaded)';
    // An ES module (no _compile): its script's own range is its length.
    const top = fns.find((f) => f.ranges.length && f.ranges[0].startOffset === 0 && f.functionName === '');
    // No clock decides: under KEPLOY_PROVEN keploy sets the app's clock back
    // to the recording's time, so a file's mtime says nothing here.
    if (top) return top.ranges[0].endOffset !== g.textLen ? `V8 ran ${top.ranges[0].endOffset} characters of it, the file has ${g.textLen}` : '';
    // Its length is not in the take: with a loader hook registered, its
    // bytes may not be the file's.
    if (this.esmHooks) return `${this.esmHooks}, and V8 did not report the module's length: its bytes cannot be checked`;
    return '';
  }

  // lines(scripts) -> {executedLinesByFile, classMismatch?, windowCut?} of
  // a takePreciseCoverage result.
  lines(scripts) {
    const t = this.table;
    const byUnit = new Map();
    const bad = new Set();
    let cut = false;
    for (const s of scripts) {
      let abs;
      try {
        abs = s.url.startsWith('file:') ? fileURLToPath(s.url) : s.url;
      } catch {
        continue;
      }
      const g = path.isAbsolute(abs) ? t.gen.get(abs) : undefined;
      if (!g && t.dead.has(abs) && s.functions.some((f) => f.ranges.some((r) => r.count > 0))) {
        // A script whose unit the table holds not measured ran: the test's
        // lines lack it, so the record names it.
        for (const u of t.dead.get(abs)) bad.add(u);
        continue;
      }
      if (!g) {
        // A script under the root that the table does not hold (Node's own
        // TypeScript, a file written after the table was made): its lines
        // would be dropped unsaid, so the window is cut.
        const rel = path.isAbsolute(abs) ? t.appScript(abs) : null;
        if (rel) {
          cut = true;
          this.once(`unknown:${rel}`, `${rel} ran, and the build table does not hold it: the tests it runs in are cut (not measured)`);
        }
        continue;
      }
      // A function that ran with no block counts: another inspector client
      // turned V8's precise coverage off, and counts no longer reset.
      if (s.functions.some((f) => f.isBlockCoverage === false && f.ranges[0] && f.ranges[0].count > 0)) {
        cut = true;
        this.once('best-effort', 'V8 left precise coverage (an inspector client stopped the Profiler): the tests\' windows are cut');
        continue;
      }
      if (t.dead.has(abs) && s.functions.some((f) => f.ranges.some((r) => r.count > 0))) {
        for (const u of t.dead.get(abs)) bad.add(u);
      }
      const why = this.mismatched(abs, g, s.functions);
      if (why) {
        for (const u of g.unitNames) bad.add(u);
        this.once(`mismatch:${abs}`, `not measured: ${path.relative(this.root, abs)}: ${why}`);
        continue;
      }
      // A CommonJS file compiled with its BOM: V8 counts it.
      const offs = this.bom.has(abs) ? g.offs.map((o) => o + 1) : g.offs;
      for (const i of hitEntries(s.functions, offs)) {
        const unit = t.names[g.units[i]];
        let set = byUnit.get(unit);
        if (!set) byUnit.set(unit, (set = new Set()));
        set.add(g.lines[i]);
      }
    }
    const executedLinesByFile = {};
    for (const unit of [...byUnit.keys()].sort()) {
      if (bad.has(unit)) continue;
      executedLinesByFile[unit] = [...byUnit.get(unit)].sort((a, b) => a - b);
    }
    const out = { executedLinesByFile };
    if (bad.size) out.classMismatch = [...bad].sort();
    if (cut) out.windowCut = true;
    return out;
  }

  async tableAsk() {
    if (this.why()) return ignored(`the app is not measured: ${this.disabled}`);
    if (this.streaming) return ignored('a build table stream is on its way');
    this.streaming = true;
    const t = await this.awaitTable(TABLE_WAIT_MS);
    if (!t) {
      this.streaming = false;
      return ignored(this.tableErr || 'the app\'s build table is still being made');
    }
    setImmediate(() => {
      this.streamTable(t).catch((e) => say(`the build table stream broke: ${e.message}`)).finally(() => {
        this.streaming = false;
      });
    });
    return ACK;
  }

  // streamTable sends the table part, then the empty probes part, cutting
  // one frame at a time.
  async streamTable(t) {
    const send = async (part, payload) => {
      const total = streamTotal(payload);
      let seq = 0;
      let off = 0;
      do {
        const chunk = payload.subarray(off, off + FRAME_PAYLOAD);
        off += chunk.length;
        const f = frame(part, t.build, chunk, seq++, off >= payload.length, total);
        const answer = await sendOnce(this.data, f, FRAME_TIMEOUT_MS, true);
        if (answer.trim() !== 'OK') throw new Error(`keploy answered a frame ${JSON.stringify(answer)}`);
      } while (off < payload.length);
    };
    await send('table', t.ndjson);
    await send('probes', Buffer.alloc(0));
    debug(`sent build ${t.build}: ${t.unitCount} files, ${t.ndjson.length} bytes`);
  }

  // command(line) -> the answer line.
  command(line) {
    const sp = line.indexOf(' ');
    const action = sp < 0 ? line : line.slice(0, sp);
    const arg = sp < 0 ? '' : line.slice(sp + 1);
    if (action === 'TABLE' && sp < 0) return this.tableAsk().catch((e) => ignored(`TABLE failed: ${e.message}`));
    if ((action === 'START' || action === 'END') && arg) {
      // One test at a time, in the order they came.
      const run = () => (action === 'START' ? this.start(arg) : this.end(arg));
      const p = this.queue.then(run, run);
      this.queue = p.catch(() => {});
      return p.catch((e) => ignored(`${action} failed: ${e.message}`));
    }
    return Promise.resolve(ignored(`unknown command ${JSON.stringify(line.slice(0, 64))}`));
  }

  serve(conn) {
    conn.unref();
    conn.setTimeout(COMMAND_IDLE_MS, () => conn.destroy());
    let buf = '';
    let done = false;
    conn.on('error', () => {});
    conn.on('data', (b) => {
      if (done) return;
      buf += b.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) {
        if (buf.length > 4096) { done = true; conn.end(ignored('a command longer than 4096 bytes')); }
        return;
      }
      done = true;
      conn.setTimeout(0);
      const line = buf.slice(0, nl).replace(/\r$/, '').trim();
      debug(`command ${line}`);
      this.command(line).then((answer) => conn.end(answer), (e) => conn.end(ignored(e.message)));
    });
  }

  // listen binds the control socket (exclusive: a cluster worker never
  // shares its primary's handle). A socket a live process serves is left to
  // it: this process marks itself a peer (<socket>.peers/<pid>, so the
  // owner fails closed on a window that ran nothing while it lives), keeps
  // precise coverage on, and binds once the path is gone or stale. A stale
  // socket (no one listening) is replaced; a path that is no socket is
  // never removed.
  listen(cb) {
    const done = (owner) => {
      if (cb) { const c = cb; cb = null; c(owner); }
    };
    const tryListen = (attempt) => {
      const server = net.createServer((c) => this.serve(c));
      server.unref();
      server.once('error', (e) => {
        if (e.code !== 'EADDRINUSE' || attempt > 3) {
          say(`could not serve ${this.control}: ${e.message}: this process (pid ${process.pid}) is not measured`);
          return done(false);
        }
        this.probe((state) => {
          if (state === 'live') return this.notOwner(done);
          if (state === 'stale') {
            if (!isSocketPath(this.control)) {
              say(`${this.control} is not a socket: it is left as it is, and this process is not measured`);
              return done(false);
            }
            try { fs.unlinkSync(this.control); } catch { /* gone already */ }
          }
          return tryListen(attempt + 1);
        });
      });
      server.listen({ path: this.control, exclusive: true }, () => {
        server.on('error', (e) => say(`${this.control}: ${e.message}`));
        this.server = server;
        this.owner = true;
        this.unmarkPeer();
        try {
          fs.chmodSync(this.control, 0o666);
          this.ownIno = fs.statSync(this.control).ino;
        } catch {
          // keploy runs as the same user or root
        }
        debug(`serving ${this.control}`);
        done(true);
      });
    };
    tryListen(0);
  }

  // probe(cb): 'live' (a process serves the socket), 'stale' (no one
  // listens) or 'none' (no file).
  probe(cb) {
    if (!fs.existsSync(this.control)) return cb('none');
    const c = net.createConnection(this.control);
    c.unref();
    c.on('connect', () => { c.destroy(); cb('live'); });
    c.on('error', () => cb('stale'));
  }

  // The peers dir: one per user, which only that user may write (0700,
  // owned by it), so no other user can plant marks, or hide them.
  peersDir() {
    return peersDirOf(this.control);
  }

  // trustedPeers -> "" when the peers dir is this user's own 0700 dir (or
  // there is none), else why its marks cannot be trusted.
  trustedPeers() {
    return untrusted(this.peersDir());
  }

  // markPeer marks this process as one of the app's, at its preload,
  // before it knows whether it will own the socket (an owner removes its
  // mark once it binds). A mark is never removed on exit: a process that
  // came and went during a window still shows.
  markPeer() {
    if (this.peerMark) return;
    this.peerMark = writePeerMark(this.control);
  }

  unmarkPeer() {
    if (!this.peerMark) return;
    try { fs.unlinkSync(this.peerMark); } catch { /* gone already */ }
    this.peerMark = '';
  }

  // readMarks(prune) -> the pids marked (not this process's); with prune,
  // the marks of dead processes are removed (at START, once read).
  readMarks(prune) {
    let names;
    try {
      names = fs.readdirSync(this.peersDir());
    } catch {
      return new Set();
    }
    const out = new Set();
    for (const n of names) {
      const pid = Number(n);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      if (prune && !alive(pid)) {
        try { fs.unlinkSync(path.join(this.peersDir(), n)); } catch { /* gone */ }
        continue;
      }
      out.add(pid);
    }
    return out;
  }

  // peersInWindow -> why the test's window may hold work of other
  // processes of the app (a mark new since START, or a live one), or "".
  peersInWindow() {
    const why = this.trustedPeers();
    if (why) return why;
    const start = this.startMarks || new Set();
    const pids = [...this.readMarks(false)].filter((pid) => !start.has(pid) || alive(pid));
    if (!pids.length) return '';
    return `the app serves requests in other processes (workers, pids ${pids.slice(0, 5).join(', ')}) that keploy cannot measure; run one process`;
  }

  notOwner(done) {
    this.once('not-owner', `another process serves ${this.control}: this process (pid ${process.pid}) is not measured while it does`);
    const t = setTimeout(() => {
      this.probe((state) => {
        if (state === 'live') return this.notOwner(() => {});
        this.listen((owner) => {
          // Precise coverage was on all along: from here this process is
          // measured as an owner started at its preload is.
          if (owner) say(`the process that served ${this.control} is gone: this process (pid ${process.pid}) serves keploy's coverage from now on`);
        });
      });
    }, OWNER_RETRY_MS);
    t.unref();
    done(false);
  }

  // close removes the control socket when it is still this process's, and
  // this process's peer mark.
  close() {
    try {
      if (this.ownIno && fs.statSync(this.control).ino === this.ownIno) fs.unlinkSync(this.control);
    } catch {
      // gone already
    }
  }
}

/**
 * mainScript() -> this process's main script, resolved, or "".
 */
function mainScript() {
  const main = process.argv[1];
  if (!main) return '';
  let abs = path.resolve(main);
  try {
    abs = fs.realpathSync(abs);
  } catch {
    // "node dist/main" with no extension: the resolved path is enough
  }
  return abs;
}

/**
 * mainInRoot(root, abs) -> whether the main script abs is the app's: a file
 * under root, not under node_modules. npm, npx, nodemon, jest and other
 * tools that start the app run their own main script, and are not measured
 * (their child, the app, is).
 */
function mainInRoot(root, abs) {
  if (!abs) return false;
  const rel = path.relative(root, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules');
}

module.exports = { Agent, frames, frame, sendOnce, mainInRoot, mainScript, writePeerMark, ACK, ignored, SYSTEM_DIRS };
