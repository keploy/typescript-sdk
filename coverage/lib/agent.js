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
// The longest END waits for the window's own work still under way.
const SETTLE_MS = 50;
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

const DEBUG = !!process.env.KEPLOY_COVERAGE_DEBUG;

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
  return ownRun(() => new Promise((resolve, reject) => {
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
  }));
}

// ownRun(fn): fn as keploy's own work, once the adapter has its async
// tracking (Agent.hookAsync sets it).
let ownRun = (fn) => fn();

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

// peersDirOf(control) -> the peers dir of a control socket: shared by
// every user (1777, sticky), so a process of the app running as another user
// still marks itself. A mark planted there only makes the owner fail closed
// (IGNORED), never send wrong lines.
function peersDirOf(control) {
  return `${control}.peers`;
}

// untrusted(dir) -> "" when dir is a real shared dir: not a link, owned by
// root or this user, sticky and writable by all (1777); or absent.
function untrusted(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return '';
  }
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : st.uid;
  if (!st.isDirectory() || (st.uid !== 0 && st.uid !== euid) || (st.mode & 0o7777) !== 0o1777) {
    return `${dir} is not a shared sticky dir (1777) owned by root or this user, so keploy cannot tell whether other processes of the app run`;
  }
  return '';
}

// makePeersDir makes the peers dir with no race: a fresh dir is set to 1777,
// then renamed into place (one that is there already is left to be checked).
function makePeersDir(dir) {
  if (fs.existsSync(dir)) return;
  let tmp;
  try {
    tmp = fs.mkdtempSync(`${dir}.tmp-`);
    fs.chmodSync(tmp, 0o1777);
    fs.renameSync(tmp, dir);
    tmp = '';
  } catch {
    // another process made it first
  } finally {
    if (tmp) try { fs.rmdirSync(tmp); } catch { /* gone */ }
  }
}

// writePeerMark(control) -> the mark this process wrote in the peers dir
// (synchronously, never through a link), or "" when it could not, said on
// stderr.
function writePeerMark(control) {
  const dir = peersDirOf(control);
  makePeersDir(dir);
  const why = untrusted(dir);
  if (why) {
    say(`${why}: this process (pid ${process.pid}) cannot mark itself`);
    return '';
  }
  const f = path.join(dir, String(process.pid));
  const c = fs.constants;
  for (let i = 0; i < 2; i++) {
    try {
      fs.closeSync(fs.openSync(f, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o644));
      return f;
    } catch (e) {
      // An old mark of this pid (a pid reused): replace it, once.
      if (e.code === 'EEXIST' && i === 0) {
        try { if (fs.lstatSync(f).isFile()) fs.unlinkSync(f); } catch { /* not ours */ }
        continue;
      }
      say(`could not mark this process (pid ${process.pid}) as one of the app's: ${e.message}`);
      return '';
    }
  }
  return '';
}

const internalTimers = new WeakSet();
// internalTimer(timeout) -> whether a Timeout is Node's own bookkeeping: a
// socket's idle timeout (marked by identity when net sets it), or Node's
// unref'd HTTP Date cache and connection check.
function internalTimer(t) {
  // By identity only (a socket's idle timeout, marked when net sets it).
  // Node's HTTP Date cache and connection check are unref'd timers, which
  // pending never counts; an app timer of the same name is the app's.
  return !!t && typeof t === 'object' && internalTimers.has(t);
}

// markSocketTimeouts: the idle timeout a socket keeps (net's setTimeout,
// HTTP's keep-alive) is Node's own, never the app's work.
function markSocketTimeouts() {
  const proto = net.Socket.prototype;
  const orig = proto.setTimeout;
  if (typeof orig !== 'function' || orig.__keployCoverage) return;
  const wrapped = function (...args) {
    const r = orig.apply(this, args);
    try {
      for (const sym of Object.getOwnPropertySymbols(this)) {
        if (sym.description === 'timeout' && this[sym] && typeof this[sym] === 'object') internalTimers.add(this[sym]);
      }
    } catch {
      // never in the app's way
    }
    return r;
  };
  wrapped.__keployCoverage = true;
  proto.setTimeout = wrapped;
}

// isHttpServerHandle(h) -> whether a listening handle is an HTTP server's.
let httpServerClass = null;
function isHttpServerHandle(h) {
  try {
    if (!h || typeof h !== 'object') return false;
    const sym = Object.getOwnPropertySymbols(h).find((x) => x.description === 'owner_symbol');
    const owner = sym ? h[sym] : h.owner;
    if (!httpServerClass) httpServerClass = require('http').Server;
    return !!owner && owner instanceof httpServerClass;
  } catch {
    return false;
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
    this.startup = null;
    this.windowSeq = 0;
    this.partialWhy = '';
    this.asyncTags = null; // asyncId -> {type, k, w, server}: async resources, once hooked
    this.pending = new Set(); // ids of the window's timers, children and requests not done
    this.keepAlive = new WeakSet(); // the handles of the sockets the window's requests came on
    this.windowBad = new Set();
    this.windowCutSeen = false;
    this.ownedIds = new Set(); // resources of the window's requests (their socket and parser)
    this.foreignDepth = 0;
    this.acc = null; // the window's lines so far: Map<unit, Set<line>>
    this.foreignLines = null; // app lines foreign work ran: Map<unit, Set<line>>
    this.requestsInWindow = 0;
    this.acceptsInWindow = 0; // connections an HTTP server accepted in the window
    this.acceptFrame = 0; // the async id of the first accept's callback, while it runs
    this.acceptInit = null; // the connection a server accepted, before its callback
    this.provisional = 0; // an earlier test's connection read at the window's start
    this.acceptedIds = new Set(); // the handles made in that callback (its socket, a TLS wrap)
    this.foreignOnlyConn = false; // the open bracket is only earlier tests' own connections
    this.asyncHook = null;
    this.mode = 'window';
    this.depthStack = [];
    this.ownedStack = [];
    this.frames = [];
    this.lateDepth = 0;
    this.lateStack = [];
    this.lateFor = 0;
    this.foreignLate = [];
    this.lastSeq = 0;
    this.windowIds = new Map(); // window seq -> its test's id (the last 2000)
    this.amended = new Set();
    this.foreignTypes = [];
    this.takeFailed = false;
    this.startAlive = new Set();
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

  // hookAsync tells the test's own lines from other work's in its window,
  // by the lines themselves. Each async resource is tagged when it is made:
  // keploy's own (made under keploy's store), the window's (made under a
  // request of the window, or by a callback of the window's), or foreign.
  // Every foreign callback that runs in the window is bracketed: at its
  // before, V8's counts are taken and folded into the window's lines; at its
  // after, they are taken again, and any app line in that delta ran in work
  // that is not the test's: those lines are never credited, and the window
  // is partial. A driver in node_modules that resolves the handler's promise
  // runs no app line there (the handler's continuation runs after the
  // callback's after, in the window's context), so a pooled DB socket is no
  // partial. Resources the window's work made that are still pending at END
  // (a timer, a file or socket operation, a child) also make it partial.
  hookAsync() {
    let ah;
    try {
      ah = require('async_hooks');
    } catch {
      return;
    }
    if (!ah.AsyncLocalStorage || this.als) return;
    // Node 18 is end of life: its async hooks (with the in-hook takes) ran
    // away on it, so it gets no async tracking, and every window is partial.
    if (Number(process.versions.node.split('.')[0]) < 20) {
      this.eol = `Node ${process.versions.node} is end of life: keploy cannot tell its async work apart; use Node 20+`;
      return;
    }
    const agent = this;
    this.als = new ah.AsyncLocalStorage();
    this.K = { k: true };
    const tags = new Map();
    this.asyncTags = tags;
    // A socket the test writes to (a query on a pooled or callback-driver
    // connection) is the test's until its reply: its callbacks after END
    // amend that test when they run app code. (A small write leaves no
    // write request behind, so the write itself is marked.)
    const agent0 = this;
    for (const name of ['write', 'end']) {
      const orig = net.Socket.prototype[name];
      net.Socket.prototype[name] = function (...args) {
        try {
          const h = this._handle;
          if (h && typeof h.getAsyncId === 'function') {
            const st = agent0.als.getStore();
            let w = 0;
            if (st !== agent0.K) {
              if (agent0.lateDepth > 0) w = agent0.lateFor;
              else if (agent0.window !== null && agent0.foreignDepth === 0 && ((st && st.w === agent0.windowSeq) || agent0.ownedStack.length)) w = agent0.windowSeq;
            }
            if (w) {
              const tag = tags.get(h.getAsyncId());
              if (tag && !tag.k) tag.usedBy = w;
            }
          }
        } catch {
          // never in the app's way
        }
        return orig.apply(this, args);
      };
    }
    // Work the window started that will still run code: its timers and
    // immediates, its child processes, and every libuv request still in
    // flight (fs, DNS, connect, write, crypto: a request is done when its
    // callback has run, at destroy). An open handle (a keep-alive socket, a
    // zlib stream, a FileHandle, a TLS socket) is not work by itself: what
    // waits on it is a promise continuation, tracked below.
    const PENDING_HANDLES = new Set(['Timeout', 'Immediate', 'PROCESSWRAP']);
    const SERVERS = new Set(['TCPSERVERWRAP', 'PIPESERVERWRAP']);
    const isRequest = (type) => /REQ(UEST|WRAP)?$|^FSREQ|CONNECTWRAP$|^(WRITE|SHUTDOWN|UDPSEND)WRAP$/.test(type);
    this.asyncHook = ah.createHook({
      init(asyncId, type, triggerAsyncId, resource) {
        try {
          if (agent.window === null && agent.foreignDepth === 0 && agent.lateDepth === 0 && type === 'PROMISE') return;
          // (A promise made outside any window and outside foreign work is
          // left untagged: one that runs in a window is foreign, below.)
          const st = agent.als.getStore();
          const trig = type === 'PROMISE' ? null : tags.get(triggerAsyncId);
          let tag;
          // A handle or request keploy's own handle made (a connection its
          // control server accepted, a write on its socket) is keploy's.
          if (trig && trig.k) tag = { type, k: true, w: 0, f: false };
          else if (agent.lateDepth > 0) tag = { type, k: false, w: agent.lateFor, f: false };
          else if (agent.foreignDepth > 0) tag = { type, k: false, w: 0, f: true };
          else if (st === agent.K) tag = { type, k: true, w: 0, f: false };
          // Made in a callback of the window's (its request's socket or
          // parser, on Node 24 a context with no store): the window's.
          else if (agent.window !== null && agent.ownedStack.length) tag = { type, k: false, w: agent.windowSeq, f: false };
          else tag = { type, k: false, w: st && st.w ? st.w : 0, f: false };
          if (type === 'PROMISE' && !tag.f && !tag.w) return;
          // A connection a server accepts is made before its server's
          // callback runs: kept until that callback says whether it is the
          // window's first accept.
          if (trig && SERVERS.has(trig.type) && (type === 'TCPWRAP' || type === 'PIPEWRAP')) agent.acceptInit = { id: asyncId, server: triggerAsyncId };
          if (agent.acceptFrame && (type === 'TCPWRAP' || type === 'PIPEWRAP' || type === 'TLSWRAP') && ah.executionAsyncId() === agent.acceptFrame) {
            agent.acceptedIds.add(asyncId);
            tag.conn = true;
          }
          if (DEBUG) tag.at = `${st ? JSON.stringify(st) : 'no store'}, depth ${agent.foreignDepth}, seq ${agent.windowSeq}: ${new Error().stack.split('\n').slice(3, 9).map((l) => l.trim()).join(' < ')}`;
          if (agent.window !== null && tag.w === agent.windowSeq && !tag.f) {
            if (PENDING_HANDLES.has(type)) {
              // Held weakly: a pending entry never keeps its resource alive.
              tag.ref = new WeakRef(resource);
              agent.pending.add(asyncId);
            } else if (isRequest(type)) {
              agent.pending.add(asyncId);
            }
            // A promise is never pending: one that never settles runs no
            // code; one that runs app code after END amends the test.
          }
          tags.set(asyncId, tag);
        } catch {
          // never in the app's way
        }
      },
      before(asyncId) {
        try {
          if (agent.lateDepth > 0) {
            agent.lateDepth++;
            agent.lateStack.push(asyncId);
            return;
          }
          const tag0 = tags.get(asyncId);
          if (tag0 && tag0.k) return;
          // Between windows: work of a test whose window has ended (its
          // promise, timer, socket or request, made in its window, or made
          // by such work) is bracketed, and if it runs app code that test is
          // amended partial. In a window it is foreign work (below), and
          // amends its test the same way.
          const lf0 = tag0 ? Math.max(tag0.f ? 0 : tag0.w, tag0.usedBy || 0) : 0;
          if (agent.window === null && lf0 > 0) {
            agent.foldTake(new Map()); // what ran since the last take is no test's
            agent.lateFor = lf0;
            agent.lateType = tag0 ? tag0.type : 'a callback';
            agent.lateDepth = 1;
            agent.lateStack.push(asyncId);
            return;
          }
          if (agent.window === null) return;
          const tag = tag0;
          let own = agent.ownedIds.has(asyncId) || (tag && tag.w === agent.windowSeq && !tag.f);
          // A connection an HTTP server accepts in the window, before its
          // first request: it is for the test's request (keploy opens one
          // per test); a second one is caught as a second request.
          if (!own && tag && SERVERS.has(tag.type) && isHttpServerHandle(ah.executionAsyncResource())) {
            // Only the window's first accept is the test's (keploy opens at
            // most one connection per test); the handle itself is not owned,
            // so a later accept (a probe, another client's upgrade) is not.
            if (++agent.acceptsInWindow === 1 && agent.requestsInWindow === 0) {
              own = true;
              agent.acceptFrame = asyncId;
              // Its socket is the window's: its reads run as the test's.
              const ai = agent.acceptInit;
              const c = ai && ai.server === asyncId ? tags.get(ai.id) : null;
              if (c) {
                c.w = agent.windowSeq;
                c.f = false;
                c.conn = true;
                agent.acceptedIds.add(ai.id);
              }
            } else if (!agent.partialWhy) {
              agent.partialWhy = agent.acceptsInWindow > 1
                ? `the app accepted ${agent.acceptsInWindow} connections in the test's window: keploy opens one per test, so another client's connection ran in it`
                : 'the app accepted a connection after the test\'s request had started: keploy opens one per test, so another client\'s connection ran in it';
            }
            agent.acceptInit = null;
          }
          // An earlier test's connection read at the window's start, with
          // nothing run since the take: most likely this test's request on a
          // kept-alive connection. It runs with no take; the request's start
          // makes it the window's, and if it ends without one, a take then
          // keeps its lines apart (that test's late work).
          if (!own && tag && tag.conn && agent.mode === 'window' && !agent.windowRan && !agent.frames.length && !agent.provisional) {
            agent.frames.push({ id: asyncId, own: false, prov: Math.max(tag.f ? 0 : tag.w, tag.usedBy || 0) });
            agent.provisional = asyncId;
            return;
          }
          agent.frames.push({ id: asyncId, own: !!own });
          if (own) {
            // The window's work again: a bracket waiting to be closed is.
            if (agent.mode === 'ended' || agent.mode === 'foreign') agent.closeForeign();
            agent.ownedStack.push(asyncId);
            agent.windowRan = true;
            return;
          }
          agent.foreignDepth++;
          agent.depthStack.push(asyncId);
          const lf = tag ? Math.max(tag.f ? 0 : tag.w, tag.usedBy || 0) : 0;
          if (lf > 0 && lf < agent.windowSeq && !agent.foreignLate.includes(lf)) agent.foreignLate.push(lf);
          // An earlier test's own connection (its socket, closing or ending
          // after its window): its lines are that test's late work only.
          const connLate = !!(tag && tag.conn && lf > 0 && lf < agent.windowSeq);
          if (agent.mode === 'foreign') agent.foreignOnlyConn = agent.foreignOnlyConn && connLate;
          if (agent.mode === 'ended') {
            // Foreign work right after foreign work: one bracket, no take
            // between, since no work of the window's ran between them.
            agent.mode = 'foreign';
            agent.foreignOnlyConn = agent.foreignOnlyConn && connLate;
            if (tag && agent.foreignTypes.length < 8 && !agent.foreignTypes.includes(tag.type)) agent.foreignTypes.push(tag.type);
            return;
          }
          if (agent.mode !== 'foreign') {
            // Nothing of the window's ran since the last take (only keploy's
            // own work, or none): no take is needed to keep it apart.
            if (agent.windowRan) agent.foldTake(agent.acc);
            agent.mode = 'foreign';
            agent.foreignTypes = [tag ? tag.type : 'a callback'];
            agent.foreignLate = lf > 0 && lf < agent.windowSeq ? [lf] : [];
            agent.foreignOnlyConn = connLate;
            agent.foreignAt = tag && tag.at;
            if (DEBUG) debug(`bracket ${asyncId} ${agent.foreignTypes.join(', ')}`);
          }
        } catch {
          // never in the app's way
        }
      },
      after(asyncId) {
        try {
          const ls = agent.lateStack;
          if (ls.length && ls[ls.length - 1] === asyncId) {
            ls.pop();
            if (--agent.lateDepth === 0) agent.closeLate();
            return;
          }
          const tag = tags.get(asyncId);
          if (tag && tag.ref) {
            const r = tag.ref.deref();
            if (!r || tag.type === 'Immediate' || (tag.type === 'Timeout' && !r._repeat)) agent.pending.delete(asyncId);
          }
          const os = agent.ownedStack;
          if (os.length && os[os.length - 1] === asyncId) os.pop();
          const st = agent.depthStack;
          if (st.length && st[st.length - 1] === asyncId) {
            st.pop();
            agent.foreignDepth = Math.max(0, agent.foreignDepth - 1);
          }
          if (agent.acceptFrame === asyncId) agent.acceptFrame = 0;
          const fr = agent.frames;
          if (!fr.length || fr[fr.length - 1].id !== asyncId) return;
          const done = fr.pop();
          if (agent.window === null) return;
          if (done.prov !== undefined && agent.provisional === asyncId) {
            // No request started in it: its lines are kept apart.
            agent.provisional = 0;
            if (agent.mode === 'foreign' || agent.mode === 'ended') {
              agent.closeForeign();
            } else {
              const m = new Map();
              agent.foldTake(m);
              if (m.size && done.prov > 0) agent.amend(done.prov, `work the test started ran app code after its end (${tag ? tag.type : 'a callback'}): ${[...m.keys()][0]}`);
            }
            agent.windowRan = false;
            return;
          }
          // Back in the frame this callback ran inside (a nested scope):
          // its kind decides again, with a take where it changes, so no
          // line of the outer frame is counted as the inner one's.
          const outer = fr.length ? fr[fr.length - 1] : null;
          if (!outer) {
            if (!done.own && agent.mode === 'foreign') agent.mode = 'ended';
            return;
          }
          if (outer.own && !done.own) agent.closeForeign();
          else if (!outer.own && done.own) {
            agent.foldTake(agent.acc);
            agent.mode = 'foreign';
          }
        } catch {
          // never in the app's way
        }
      },
      destroy(asyncId) {
        tags.delete(asyncId);
        agent.pending.delete(asyncId);
      },
    });
    markSocketTimeouts();
    if (!this.disabled) this.asyncHook.enable();
    ownRun = (fn) => this.als.run(this.K, fn);
  }

  // closeLate ends a late bracket: app lines in it ran after their test's
  // end; they are no test's, and the test is amended partial.
  closeLate() {
    const lines = new Map();
    this.foldTake(lines);
    if (!lines.size) return;
    const file = [...lines.keys()][0];
    this.amend(this.lateFor, `work the test started ran app code after its end (${this.lateType}): ${file}`);
  }

  // amend sends a late partial for the test of window seq, once.
  amend(seq, why) {
    const id = this.windowIds.get(seq);
    if (!id || this.amended.has(id)) return;
    this.amended.add(id);
    debug(`amend ${id}: ${why}`);
    // "test", never "id": a record with an id is read as the test's coverage.
    const rec = JSON.stringify({ kind: 'amend', v: 1, test: id, partial: why });
    this.own(() => sendOnce(this.data, rec, SEND_TIMEOUT_MS, false)).catch((e) => say(`could not send the amendment of ${id}: ${e.message}`));
  }

  // closeForeign ends the foreign bracket: the app lines that ran since the
  // switch away from the window's work are foreign; from here the work is
  // the window's again.
  closeForeign() {
    if ((this.mode !== 'foreign' && this.mode !== 'ended') || this.window === null) return;
    const got = new Map();
    this.foldTake(got);
    if (got.size) {
      for (const [u, ls] of got) {
        let set = this.foreignLines.get(u);
        if (!set) this.foreignLines.set(u, (set = new Set()));
        for (const x of ls) set.add(x);
      }
      const file = [...got.keys()][0];
      if (!this.partialWhy && !this.foreignOnlyConn) {
        this.partialWhy = `work that is not the test's (${this.foreignTypes.join(', ')}) ran app code in its window (${file})`;
        debug(`partial: ${this.partialWhy} [made ${this.foreignAt}]`);
      }
      // Work an earlier test started: that test is amended too.
      for (const seq of this.foreignLate) this.amend(seq, `work the test started ran app code after its end (${this.foreignTypes.join(', ')}): ${file}`);
    }
    this.foreignLate = [];
    this.foreignOnlyConn = false;
    this.mode = 'window';
    // Back in the window's own work (the frame that entered the scope):
    // the next foreign scope needs its take.
    this.windowRan = true;
  }

  // foldTake takes V8's counts (which resets them) and adds the app lines
  // they ran into into (Map<unit, Set<line>>); a take that fails marks the
  // window cut.
  foldTake(into) {
    this.windowRan = false;
    let got = null;
    const t0 = DEBUG || this.stats ? process.hrtime.bigint() : 0n;
    this.session.post('Profiler.takePreciseCoverage', (e, r) => { got = e ? null : r; });
    const t1 = t0 ? process.hrtime.bigint() : 0n;
    if (!got) {
      // The take did not answer at once: the bracket cannot tell lines apart.
      this.takeFailed = true;
      return;
    }
    const l = this.lines(got.result);
    for (const [u, ls] of Object.entries(l.executedLinesByFile)) {
      let set = into.get(u);
      if (!set) into.set(u, (set = new Set()));
      for (const x of ls) set.add(x);
    }
    this.foldExtra(l);
    if (t0) {
      const st = this.stats || (this.stats = { takes: 0, postNs: 0n, mapNs: 0n, scripts: 0 });
      st.takes++;
      st.postNs += t1 - t0;
      st.mapNs += process.hrtime.bigint() - t1;
      st.scripts += got.result.length;
    }
  }

  // foldExtra keeps what a take says beyond lines (classMismatch, a cut,
  // partial) for the window's record.
  foldExtra(l) {
    if (l.classMismatch) for (const u of l.classMismatch) this.windowBad.add(u);
    if (l.windowCut) this.windowCutSeen = true;
    if (l.partial && !this.partialWhy) this.partialWhy = l.partial;
  }

  // pendingWhy -> why the window's own work is not done at END (a resource
  // it made that is still pending: a timer, a file or socket operation, a
  // child process), or "".
  pendingWhy() {
    if (!this.asyncTags) return '';
    for (const id of this.pending) {
      const tag = this.asyncTags.get(id);
      if (!tag) continue;
      const r = tag.ref ? tag.ref.deref() : null;
      if (tag.ref && !r) continue;
      if (tag.type === 'Timeout' && (internalTimer(r) || (typeof r.hasRef === 'function' && !r.hasRef()))) continue;
      debug(`pending at END: ${tag.type} [made ${tag.at}]`);
      return `work the test's requests started (${tag.type}) was still running at END`;
    }
    return '';
  }

  // settle waits, a bounded while, for the window's own work still under
  // way (a reply on a pooled socket after the response, a crypto job) with
  // the brackets on, so its lines land in the window: up to SETTLE_MS.
  async settle() {
    const until = process.hrtime.bigint() + BigInt(SETTLE_MS) * 1000000n;
    while (this.pendingWhy() && process.hrtime.bigint() < until) {
      // keploy's own wait: its promise and timer are never the window's.
      await this.own(() => new Promise((r) => setTimeout(r, 2)));
    }
  }

  // own(fn) runs fn as keploy's own work: the async resources it makes are
  // never the test's or other work.
  own(fn) {
    return this.als ? this.als.run(this.K, fn) : fn();
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
      dc.subscribe('http.server.request.start', (msg) => {
        try {
          this.inFlight++;
          if (msg && msg.response) msg.response.once('close', () => { this.inFlight = Math.max(0, this.inFlight - 1); });
          if (!this.als) return;
          if (this.window === null) {
            this.als.enterWith({ w: -1 });
            return;
          }
          // keploy sends one request per test: a second one in the window is
          // another client's, or ambiguous.
          if (++this.requestsInWindow > 1 && !this.partialWhy) this.partialWhy = 'more than one request ran in the test\'s window';
          // What ran before this request in the callback it starts in is
          // checked; the rest is the window's.
          this.closeForeign();
          this.windowRan = true;
          this.foreignDepth = 0;
          this.depthStack.length = 0;
          try {
            const cur = require('async_hooks').executionAsyncId();
            this.ownedIds.add(cur);
            // Once: the callback may be the window's already (a connection
            // accepted in the window), and its after pops it once.
            if (this.ownedStack[this.ownedStack.length - 1] !== cur) this.ownedStack.push(cur);
            const top = this.frames[this.frames.length - 1];
            if (top && top.id === cur) top.own = true;
            if (this.provisional === cur) this.provisional = 0;
          } catch { /* no id */ }
          const store = { w: this.windowSeq };
          this.als.enterWith(store);
          // The request's body and response events run in its context (on
          // Node 24 the parser's own context has no window).
          for (const em of [msg && msg.request, msg && msg.response]) {
            if (!em || em.__keployCoverage) continue;
            const orig = em.emit;
            const agent = this;
            em.emit = function (...a) { return agent.als.run(store, () => orig.apply(this, a)); };
            em.__keployCoverage = true;
          }
          // The request's socket and its HTTP parser (which reads the body
          // from the socket's handle) run the test's request in this window.
          const sock = msg && msg.socket;
          for (const r of [sock && sock._handle, sock && sock.parser, sock && sock.parser && sock.parser[Object.getOwnPropertySymbols(sock.parser).find((x) => /resource/i.test(String(x.description)))]]) {
            if (r && typeof r.getAsyncId === 'function') {
              const rid = r.getAsyncId();
              this.ownedIds.add(rid);
              const tg = this.asyncTags && this.asyncTags.get(rid);
              if (tg) tg.conn = true;
            }
          }
          // A connection accepted in the window that is not the one this
          // request came on was another client's.
          const hid = sock && sock._handle && typeof sock._handle.getAsyncId === 'function' ? sock._handle.getAsyncId() : 0;
          if (this.acceptedIds.size && hid && !this.acceptedIds.has(hid) && !this.partialWhy) {
            this.partialWhy = 'a connection the app accepted in the test\'s window was not the one the test\'s request came on: another client\'s connection ran in it';
          }
          if (sock && sock.parser && typeof sock.parser.getAsyncId !== 'function') this.parserIdFromHook = true;
          if (msg && msg.socket) this.keepAlive.add(msg.socket._handle);
        } catch {
          // never in the app's way
        }
      });
      // (Counted down at the response's close, which comes whether it
      // finished or its client went away.)
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
    const pause = () => new Promise((r) => this.own(() => setImmediate(r)));
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
      if (this.asyncHook) this.asyncHook.disable();
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
    // The STARTUP record goes to each new receiver too.
    if (this.startup) {
      try {
        await sendOnce(this.data, JSON.stringify(this.startup), INDEX_TIMEOUT_MS, false);
      } catch (e) {
        say(`could not send the STARTUP record: ${e.message}`);
      }
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
    let first;
    try {
      first = await this.post('Profiler.takePreciseCoverage');
    } catch (e) {
      return ignored(`could not reset V8's counts: ${e.message}`);
    }
    // The window opens at once, with the take: no line runs between them
    // unseen (the STARTUP record is sent from the take, after).
    this.lateDepth = 0;
    this.lateStack.length = 0;
    this.foreignLate = [];
    this.windowSeq++;
    this.windowIds.set(this.windowSeq, id);
    if (this.windowIds.size > 2000) this.windowIds.delete(this.windowSeq - 2000);
    this.partialWhy = '';
    this.pending.clear();
    if (process.env.KEPLOY_COVERAGE_STATS) this.stats = { takes: 0, postNs: 0n, mapNs: 0n, scripts: 0 };
    this.acc = new Map();
    this.foreignLines = new Map();
    this.foreignDepth = 0;
    this.depthStack.length = 0;
    this.ownedStack.length = 0;
    this.frames.length = 0;
    this.mode = 'window';
    this.windowRan = false;
    this.ownedIds.clear();
    this.requestsInWindow = 0;
    this.acceptsInWindow = 0;
    this.acceptFrame = 0;
    this.acceptInit = null;
    this.provisional = 0;
    this.acceptedIds.clear();
    this.windowBad = new Set();
    this.windowCutSeen = false;
    this.takeFailed = false;
    this.window = id;
    this.workersInWindow = this.workers.size;
    this.startMarks = this.readMarks(true);
    this.startAlive = new Set([...this.startMarks].filter(alive));
    this.windowStartedBusy = this.inFlight > 0;
    if (!this.startup) {
      // The lines the process ran before its first window (its import, the
      // app's start): keploy keeps them as the run's startup, never a test's.
      const l = this.lines(first.result);
      this.startup = { kind: 'startup', v: 1, pid: process.pid, build: t.build, executedLinesByFile: l.executedLinesByFile, fileHashes: l.fileHashes };
      if (l.classMismatch) this.startup.classMismatch = l.classMismatch;
      if (l.windowCut) this.startup.windowCut = true;
      if (l.partial) this.startup.partial = l.partial;
    }
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
    await new Promise((r) => this.own(() => setImmediate(r)));
    await new Promise((r) => this.own(() => setImmediate(r)));
    if (this.window !== id) return ignored(`END ${id}: its window was replaced while it settled`);
    if (this.asyncTags) await this.settle();
    if (this.window !== id) return ignored(`END ${id}: its window was replaced while it settled`);
    // The last of the window's lines, folded with those taken at its
    // foreign callbacks' brackets.
    const acc = this.acc;
    if (this.mode === 'foreign' || this.mode === 'ended') this.closeForeign();
    else this.foldTake(acc);
    this.window = null;
    this.lastSeq = this.windowSeq;
    this.lateDepth = 0;
    this.lateStack.length = 0;
    const record = { id, pid: process.pid, build: this.table ? this.table.build : '', executedLinesByFile: {}, fileHashes: {} };
    for (const unit of [...acc.keys()].sort()) {
      if (this.windowBad.has(unit)) continue;
      record.executedLinesByFile[unit] = [...acc.get(unit)].sort((x, y) => x - y);
      record.fileHashes[unit] = this.table.hashOf.get(unit);
    }
    if (this.windowBad.size) record.classMismatch = [...this.windowBad].sort();
    if (this.takeFailed) {
      say(`${id}: V8's counts could not be read at once: its window is cut`);
      record.windowCut = true;
    }
    if (this.windowCutSeen) record.windowCut = true;
    const out = this.outside();
    if (out) return ignored(out);
    if (this.inFlight > 0 || this.windowStartedBusy) {
      // A request still being answered: its work lands across windows.
      record.windowCut = true;
      this.once('inflight', `a test's window ended (or began) while ${this.inFlight || 'a'} request(s) were still being answered: such tests are cut (not measured)`);
    }
    const peers = this.peersInWindow();
    if (peers) return ignored(peers);
    if (DEBUG && this.asyncTags) debug(`async tags ${this.asyncTags.size}, pending ${this.pending.size}`);
    if (this.stats) {
      const st = this.stats;
      const line = `window ${id}: ${st.takes} takes, V8 and JSON ${(Number(st.postNs) / 1e6 / st.takes).toFixed(3)} ms a take, mapping ${(Number(st.mapNs) / 1e6 / st.takes).toFixed(3)} ms a take, ${Math.round(st.scripts / st.takes)} scripts a take`;
      if (process.env.KEPLOY_COVERAGE_STATS) say(line); else debug(line);
      this.stats = process.env.KEPLOY_COVERAGE_STATS ? { takes: 0, postNs: 0n, mapNs: 0n, scripts: 0 } : null;
    }
    const gone = [...this.startAlive].filter((pid) => !alive(pid));
    const partial = this.eol || this.partialWhy || this.pendingWhy() ||
      (gone.length ? `a process of the app (pid ${gone[0]}) ended during the test: its work in the window is not measured` : '');
    if (partial) {
      record.partial = partial;
      this.once(`partial:${partial}`, `a test's window holds work that is not its own (${partial}): such tests are marked partial`);
    }
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
    let partial = '';
    for (const s of scripts) {
      let abs;
      try {
        abs = s.url.startsWith('file:') ? fileURLToPath(s.url) : s.url;
      } catch {
        continue;
      }
      const g = path.isAbsolute(abs) ? t.gen.get(abs) : undefined;
      if (!g && this.held.has(abs) && s.functions.some((f) => f.ranges.some((r) => r.count > 0))) {
        // A preload of the app's that came before keploy's ran in the test:
        // its lines cannot be told, so the test is not whole.
        partial = partial || `${path.relative(this.root, abs)} ran in the test, and it was loaded before keploy's coverage preload: put keploy's --require first`;
        continue;
      }
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
    const fileHashes = {};
    for (const unit of [...byUnit.keys()].sort()) {
      if (bad.has(unit)) continue;
      executedLinesByFile[unit] = [...byUnit.get(unit)].sort((a, b) => a - b);
      // The unit's bytes this process runs: checked against the table's
      // (the compiled sha, or V8's length), so they are the table's.
      fileHashes[unit] = t.hashOf.get(unit);
    }
    const out = { executedLinesByFile, fileHashes };
    if (bad.size) out.classMismatch = [...bad].sort();
    if (cut) out.windowCut = true;
    if (partial) out.partial = partial;
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
    this.own(() => setImmediate(() => {
      this.streamTable(t).catch((e) => say(`the build table stream broke: ${e.message}`)).finally(() => {
        this.streaming = false;
      });
    }));
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
      this.command(line).then((answer) => this.own(() => conn.end(answer)), (e) => this.own(() => conn.end(ignored(e.message))));
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
        if (this.asyncHook && !this.disabled) this.asyncHook.enable();
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

  // readMarks(prune) -> every pid marked (not this process's); with prune,
  // the marks of dead processes are removed where this user may (at START,
  // once read). A dead mark that stays is not new at END, so it holds no
  // window.
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
      out.add(pid);
      if (prune && !alive(pid)) {
        try { fs.unlinkSync(path.join(this.peersDir(), n)); } catch { /* another user's, or gone */ }
      }
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
    // A process that is not the owner measures nothing: no async tracking.
    if (this.asyncHook) this.asyncHook.disable();
    this.once('not-owner', `another process serves ${this.control}: this process (pid ${process.pid}) is not measured while it does`);
    const t = this.own(() => setTimeout(() => {
      this.probe((state) => {
        if (state === 'live') return this.notOwner(() => {});
        this.listen((owner) => {
          // Precise coverage was on all along: from here this process is
          // measured as an owner started at its preload is.
          if (owner) say(`the process that served ${this.control} is gone: this process (pid ${process.pid}) serves keploy's coverage from now on`);
        });
      });
    }, OWNER_RETRY_MS));
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

module.exports = { Agent, frames, frame, sendOnce, mainInRoot, mainScript, writePeerMark, makePeersDir, untrusted, ACK, ignored, SYSTEM_DIRS };
