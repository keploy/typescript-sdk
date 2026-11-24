'use strict';
// A fake keploy agent for the adapter's tests: a data socket that takes
// records (one JSON value per connection) and KTB1 frames, checked as
// keploy's tableStore checks them (finishLocked), and a control client.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REGISTER = path.resolve(__dirname, '..', 'register.js');
const APP = path.resolve(__dirname, 'fixtures', 'app');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcov-'));
}

class FakeAgent {
  constructor(dataPath) {
    this.dataPath = dataPath;
    this.records = [];
    this.indexes = [];
    this.parts = {}; // part -> {build, payload, records, sha256}
    this.frameErrors = [];
    this.cur = null;
    this.waiters = [];
  }

  listen() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(this.dataPath); } catch { /* none */ }
      this.server = net.createServer((c) => this.take(c));
      this.server.on('error', reject);
      this.server.listen(this.dataPath, resolve);
    });
  }

  close() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  notify() {
    for (const w of this.waiters.splice(0)) w();
  }

  // until(pred, ms): resolves once pred() holds.
  async until(pred, ms = 5000) {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the fake agent');
      await new Promise((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  take(c) {
    let buf = Buffer.alloc(0);
    c.on('data', (b) => {
      buf = Buffer.concat([buf, b]);
      if (buf[0] === 0x4b /* K */) {
        if (buf.length < 8) return;
        const n = buf.readUInt32BE(4);
        if (buf.length < 8 + n) return;
        const magic = buf.subarray(0, 4).toString('latin1');
        if (magic !== 'KTB1') { this.frameErrors.push(`magic ${magic}`); c.destroy(); return; }
        if (8 + n > 1 << 20) { this.frameErrors.push(`frame of ${8 + n} bytes`); c.destroy(); return; }
        const err = this.frame(buf.subarray(8, 8 + n));
        if (err) { this.frameErrors.push(err); c.destroy(); } else c.end('OK\n');
        this.notify();
      }
    });
    c.on('end', () => {
      if (buf.length === 0 || buf[0] === 0x4b) return;
      const v = JSON.parse(buf.toString('utf8'));
      if (buf.toString('utf8').startsWith('{"kind"')) this.indexes.push(v);
      else this.records.push(v);
      this.notify();
    });
    c.on('error', () => {});
  }

  frame(body) {
    const nl = body.indexOf(0x0a);
    if (nl < 0) return 'no header line';
    const hd = JSON.parse(body.subarray(0, nl).toString('utf8'));
    const payload = body.subarray(nl + 1);
    if (hd.v !== 1) return `version ${hd.v}`;
    if (hd.seq === 0) this.cur = { part: hd.part, build: hd.build, next: 0, chunks: [] };
    const c = this.cur;
    if (!c || c.part !== hd.part || c.next !== hd.seq || c.build !== hd.build) return `frame ${hd.seq} of ${hd.part} out of order`;
    if (hd.part === 'probes' && !this.parts.table) return 'probes before the table';
    c.chunks.push(payload);
    c.next++;
    if (!hd.last) return null;
    const all = Buffer.concat(c.chunks);
    const sha = crypto.createHash('sha256').update(all).digest('hex');
    let records = 0;
    for (const b of all) if (b === 0x0a) records++;
    if (hd.records === undefined) return 'no record count on the last frame';
    if (hd.sha256 !== sha) return `sha256 ${sha}, header ${hd.sha256}`;
    if (all.length && all[all.length - 1] !== 0x0a) return 'stream does not end its last record';
    if (hd.records !== records) return `records ${records}, header ${hd.records}`;
    this.parts[hd.part] = { build: hd.build, payload: all, records, sha256: sha, frames: c.next };
    this.cur = null;
    return null;
  }
}

// command(controlPath, line) -> the adapter's answer line.
function command(controlPath, line) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(controlPath);
    let buf = '';
    s.on('connect', () => s.write(line + '\n'));
    s.on('data', (b) => { buf += b; });
    s.on('end', () => resolve(buf.replace(/\n$/, '')));
    s.on('error', reject);
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/**
 * startApp(opts) -> {child, port, stderr(), stop()}: the fixture app under
 * the preload, its sockets in dir.
 */
function startApp({ dir, requires = [REGISTER], env = {}, cwd = APP, script = 'server.js', nodeArgs = [] }) {
  const args = [...nodeArgs];
  for (const r of requires) args.push('--require', r);
  args.push(script);
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      KEPLOY_COVERAGE_CONTROL_SOCKET: path.join(dir, 'control.sock'),
      KEPLOY_COVERAGE_DATA_SOCKET: path.join(dir, 'data.sock'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const port = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /PORT (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`app exited ${code}: ${err}`)));
  });
  return {
    child,
    port,
    stderr: () => err,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', () => resolve());
      child.kill('SIGTERM');
    }),
  };
}

// waitFor(file): resolves once file is a socket (a stale plain file there
// is not one the app serves yet).
function isSocket(file) {
  try {
    return fs.statSync(file).isSocket();
  } catch {
    return false;
  }
}

// listening(file) -> whether a process accepts on the socket at file.
function listening(file) {
  return new Promise((resolve) => {
    if (!isSocket(file)) return resolve(false);
    const c = net.createConnection(file);
    c.on('connect', () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
}

async function waitFor(file, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await listening(file))) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

module.exports = { FakeAgent, command, get, startApp, waitFor, tmpDir, REGISTER, APP };
