'use strict';
// The adapter in a real app process (the fixture apps under the preload),
// driven as keploy's agent drives it: commands on the control socket,
// records and frames on a fake data socket.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { FakeAgent, command, get, startApp, waitFor, tmpDir, REGISTER, APP } = require('./helpers');
const { Agent } = require('../lib/agent');

const ACK = 'ACK proto=2';
// Node 18 is end of life: no async tracking there, and every window is
// partial with that reason.
const EOL = Number(process.versions.node.split('.')[0]) < 20;
const EOL_RE = /^Node 18\.[\d.]+ is end of life: keploy cannot tell its async work apart; use Node 20\+$/;
// whole(r): the record has no partial (on Node 18: only the end-of-life one).
function whole(r, msg = '') {
  if (EOL) assert.match(r.partial || '', EOL_RE, msg + JSON.stringify(r));
  else assert.strictEqual(r.partial, undefined, msg + JSON.stringify(r));
}
const T = { timeout: 30000 };
// TA: the rows of the async tracking, which Node 18 does not get (skipped
// by option: a skip called inside a test makes Node 18's runner exit 1).
const TA = { ...T, skip: EOL ? 'Node 18: no async tracking (end of life)' : false };
const BUNDLE = path.join(__dirname, 'fixtures', 'bundle');

// lines(r) -> the record's id and lines only.
const lines = (r) => ({ id: r.id, executedLinesByFile: r.executedLinesByFile });

async function withApp(t, opts, fn) {
  const dir = opts.dir || tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = new FakeAgent(path.join(dir, 'data.sock'));
  await agent.listen();
  const app = startApp({ dir, ...opts });
  try {
    const port = await app.port;
    await waitFor(path.join(dir, 'control.sock'));
    await fn({ dir, agent, app, port, control: path.join(dir, 'control.sock') });
  } finally {
    await app.stop();
    await agent.close();
  }
}

// window(control, port, id, route) -> the answers of START and END around a GET.
async function window(control, port, id, route) {
  const a = await command(control, `START ${id}`);
  if (route) await get(port, route);
  const b = await command(control, `END ${id}`);
  return [a, b];
}

test('each window sends the lines its test ran, and only those', T, async (t) => {
  await withApp(t, {}, async ({ agent, port, control }) => {
    // Traffic before any window is no test's.
    await get(port, '/b');
    assert.deepStrictEqual(await window(control, port, 'set-1/test-a', '/a'), [ACK, ACK]);
    assert.deepStrictEqual(await window(control, port, 'set-1/test-b', '/b'), [ACK, ACK]);
    assert.deepStrictEqual(await window(control, port, 'set-1/test-p', '/price'), [ACK, ACK]);
    assert.deepStrictEqual(await window(control, port, 'set-1/test-none', null), [ACK, ACK]);
    await agent.until(() => agent.records.length === 4);
    const [a, b, p, none] = agent.records;
    assert.strictEqual(a.id, 'set-1/test-a');
    assert.deepStrictEqual(Object.keys(a), EOL ? ['id', 'pid', 'build', 'executedLinesByFile', 'fileHashes', 'partial'] : ['id', 'pid', 'build', 'executedLinesByFile', 'fileHashes']);
    assert.deepStrictEqual(a.executedLinesByFile['lib.js'], [4, 5, 6]);
    assert.deepStrictEqual(b.executedLinesByFile['lib.js'], [9, 10, 11]);
    const sa = new Set(a.executedLinesByFile['server.js']);
    for (const l of [7, 8, 9]) assert.ok(sa.has(l), `server.js:${l} ran for /a`);
    for (const l of [1, 2, 3, 6, 12, 25]) assert.ok(!sa.has(l), `server.js:${l} did not run for /a`);
    assert.ok(!a.executedLinesByFile['src/price.ts']);
    const pl = new Set(p.executedLinesByFile['src/price.ts']);
    for (const l of [7, 8, 9, 10, 12, 16, 19, 26]) assert.ok(pl.has(l), `price.ts:${l} ran`);
    for (const l of [17, 30]) assert.ok(!pl.has(l), `price.ts:${l} did not run`);
    assert.ok(!p.executedLinesByFile['lib.js']);
    assert.deepStrictEqual(none.executedLinesByFile, {});
  });
});

test('commands it does not take are answered IGNORED, never left unanswered', T, async (t) => {
  await withApp(t, {}, async ({ agent, control }) => {
    assert.match(await command(control, 'END s/none'), /^IGNORED proto=2 END s\/none with no window open/);
    assert.match(await command(control, 'BACKGROUND'), /^IGNORED proto=2 unknown command/);
    assert.match(await command(control, 'START'), /^IGNORED proto=2 unknown command/);
    assert.strictEqual(await command(control, 'START s/1'), ACK);
    assert.match(await command(control, 'END s/2'), /^IGNORED proto=2 END s\/2 while s\/1 is open/);
    // A START while a window is open replaces it: the lost END's test sends nothing.
    assert.strictEqual(await command(control, 'START s/3'), ACK);
    assert.match(await command(control, 'END s/1'), /^IGNORED proto=2/);
    assert.strictEqual(await command(control, 'END s/3'), ACK);
    await agent.until(() => agent.records.length === 1);
    assert.deepStrictEqual(agent.records.map((r) => r.id), ['s/3']);
  });
});

test('INDEX: sent once per data socket, kind first, naming the build and the main script only', T, async (t) => {
  await withApp(t, {}, async ({ agent, port, control }) => {
    await window(control, port, 's/1', null);
    await window(control, port, 's/2', null);
    await agent.until(() => agent.records.length === 2);
    assert.strictEqual(agent.indexes.length, 1);
    const idx = agent.indexes[0];
    assert.deepStrictEqual(Object.keys(idx), ['kind', 'v', 'language', 'build', 'source', 'launch', 'roots', 'rootCount',
      'packages', 'classes', 'includes', 'jacoco', 'sdkVersion', 'jacocoVersion', 'producer', 'producerVersion']);
    assert.strictEqual(idx.kind, 'index');
    assert.strictEqual(idx.language, 'node');
    assert.match(idx.build, /^js1-[0-9a-f]{32}$/);
    assert.strictEqual(idx.launch, 'server.js');
    assert.strictEqual(idx.classes, 3);
    assert.strictEqual(idx.sdkVersion, require('../package.json').version);
    // A new receiver binds a new socket: the INDEX goes again.
    await agent.close();
    await agent.listen();
    await window(control, port, 's/3', null);
    await agent.until(() => agent.records.length === 3);
    assert.strictEqual(agent.indexes.length, 2);
    assert.strictEqual(agent.indexes[1].build, idx.build);
  });
});

test('TABLE: the table part, then an empty probes part; a second TABLE while one streams is IGNORED', T, async (t) => {
  await withApp(t, {}, async ({ agent, control }) => {
    assert.strictEqual(await command(control, 'START s/1'), ACK);
    const [a, b] = await Promise.all([command(control, 'TABLE'), command(control, 'TABLE')]);
    assert.deepStrictEqual([a, b].sort(), [ACK, 'IGNORED proto=2 a build table stream is on its way'].sort());
    await agent.until(() => agent.parts.probes || agent.frameErrors.length);
    assert.deepStrictEqual(agent.frameErrors, []);
    const tp = agent.parts.table;
    await agent.until(() => agent.indexes.length === 1);
    assert.strictEqual(tp.build, agent.indexes[0].build);
    assert.strictEqual(tp.records, 3);
    const units = tp.payload.toString('utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(units.map((u) => u.id), ['f:lib.js', 'f:server.js', 'f:src/price.ts']);
    assert.deepStrictEqual(agent.parts.probes, { build: tp.build, payload: Buffer.alloc(0), records: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', frames: 1 });
    assert.strictEqual(await command(control, 'END s/1'), ACK);
    const leaves = new Map(units.map((u) => [u.path, new Set(u.methods.flatMap((m) => m.leaves.map((l) => l[0])))]));
    await agent.until(() => agent.records.length === 1);
    for (const [file, lines] of Object.entries(agent.records[0].executedLinesByFile)) {
      for (const l of lines) assert.ok(leaves.get(file).has(l), `${file}:${l} is a leaf`);
    }
  });
});

test('TABLE: a table larger than one frame streams whole through the adapter', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let f = 0; f < 40; f++) {
    fs.writeFileSync(path.join(dir, `m${f}.js`), Array.from({ length: 1000 }, (_, i) => `exports.v${i} = ${i};`).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(dir, 'main.js'), "'use strict';\nconst s = require('http').createServer((q, r) => r.end('x'));\ns.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));\n");
  await withApp(t, { cwd: dir, script: 'main.js', dir: tmpDir() }, async ({ agent, control }) => {
    assert.strictEqual(await command(control, 'START s/1'), ACK);
    assert.strictEqual(await command(control, 'TABLE'), ACK);
    await agent.until(() => agent.parts.probes || agent.frameErrors.length, 20000);
    assert.deepStrictEqual(agent.frameErrors, []);
    assert.ok(agent.parts.table.frames >= 2, `${agent.parts.table.frames} frames`);
    assert.strictEqual(agent.parts.table.records, 41);
  });
});

test('bundles: a one-line, a wrapped and a webpack:// bundle credit the original lines each test ran', T, async (t) => {
  for (const f of ['one.js', 'wrapped.js', 'webpack.js']) {
    await withApp(t, { cwd: BUNDLE, script: `bundled/${f}` }, async ({ agent, port, control }) => {
      assert.deepStrictEqual(await window(control, port, 's/add', '/add'), [ACK, ACK]);
      assert.deepStrictEqual(await window(control, port, 's/mul', '/mul'), [ACK, ACK]);
      await agent.until(() => agent.records.length === 2);
      const [add, mul] = agent.records.map((r) => r.executedLinesByFile);
      const inAdd = (ls) => ls.length > 0 && ls.every((l) => l >= 2 && l <= 4);
      const inMul = (ls) => ls.length > 0 && ls.every((l) => l >= 7 && l <= 9);
      assert.ok(inAdd(add['src/calc.ts'] || []), `${f}: add ran ${JSON.stringify(add)}`);
      assert.ok(inMul(mul['src/calc.ts'] || []), `${f}: mul ran ${JSON.stringify(mul)}`);
      // entry.ts: the /add branch, not the /mul one (lines 5-7 against 9-11).
      assert.ok((add['src/entry.ts'] || []).some((l) => l >= 5 && l <= 7), `${f}: ${JSON.stringify(add)}`);
      assert.ok(!(add['src/entry.ts'] || []).some((l) => l >= 10 && l <= 11), `${f}: ${JSON.stringify(add)}`);
    });
  }
});

test('a load-time transform: the record names the file in classMismatch, and none of its lines', T, async (t) => {
  await withApp(t, { script: 'transform.test.js' }, async ({ agent, port, app, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/a', '/a'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    const r = agent.records[0];
    assert.deepStrictEqual(r.classMismatch, ['lib.js']);
    assert.ok(!r.executedLinesByFile['lib.js']);
    assert.ok(r.executedLinesByFile['server.js'], 'the files it did not transform are measured');
    assert.match(app.stderr(), /not measured: lib\.js: its compiled source differs from the file/);
  });
});

test('mismatch rules: compiled sha, an ES module\'s length, never a clock', () => {
  const a = new Agent({ root: '/r', env: {}, control: '', data: '' });
  const g = { textSha: 'aa', textLen: 10 };
  const fns = (len) => [{ functionName: '', ranges: [{ startOffset: 0, endOffset: len, count: 1 }] }];
  assert.strictEqual(a.mismatched('/r/x.js', g, fns(10)), '');
  a.compiled.set('/r/x.js', 'bb');
  assert.match(a.mismatched('/r/x.js', g, fns(10)), /compiled source differs/);
  a.compiled.set('/r/x.js', 'aa');
  assert.strictEqual(a.mismatched('/r/x.js', g, fns(99)), '', 'a compiled sha that matches decides');
  assert.match(a.mismatched('/r/y.mjs', g, fns(12)), /V8 ran 12 characters of it, the file has 10/);
  assert.strictEqual(a.mismatched('/r/y.mjs', g, fns(10)), '', 'an ES module of the length the table read');
  a.patchedWrap.add('/r/x.js');
  assert.match(a.mismatched('/r/x.js', g, fns(10)), /Module\.wrap was patched/);
});

test('fail closed: TypeScript compiled in memory, NODE_V8_COVERAGE, a root of /', T, async (t) => {
  const check = async (opts, re) => {
    await withApp(t, opts, async ({ agent, port, control }) => {
      const [a] = await window(control, port, 's/1', '/a');
      assert.match(a, re);
      await agent.until(() => agent.indexes.length === 1);
      assert.strictEqual(agent.indexes[0].build, '');
      assert.strictEqual(agent.indexes[0].source, 'none');
      assert.match(`IGNORED proto=2 the app is not measured: ${agent.indexes[0].launch}`, re);
      assert.match(await command(control, 'TABLE'), re);
      assert.strictEqual(agent.records.length, 0);
    });
  };
  await check({ script: 'tshook.test.js' }, /^IGNORED proto=2 the app is not measured: a require hook compiles \.ts files in memory/);
  const v8 = tmpDir();
  t.after(() => fs.rmSync(v8, { recursive: true, force: true }));
  await check({ env: { NODE_V8_COVERAGE: v8 } }, /^IGNORED proto=2 the app is not measured: NODE_V8_COVERAGE is set/);
  await check({ cwd: '/', script: path.join(APP, 'server.js') }, /^IGNORED proto=2 the app is not measured: the app's root would be \/ .*KEPLOY_APP_SOURCE_DIR/);
});

test('fail closed: a cluster primary with workers answers END IGNORED; its workers say they are not measured', T, async (t) => {
  await withApp(t, { script: 'cluster.test.js' }, async ({ port, app, control }) => {
    const [a, b] = await window(control, port, 's/1', '/a');
    assert.strictEqual(a, ACK);
    assert.match(b, /^IGNORED proto=2 the app serves from 1 cluster worker\(s\)/);
    assert.match(app.stderr(), /another process serves .*: this process \(pid \d+\) is not measured/);
  });
});

test('fail closed: a test during which the app ran a worker thread of its own code is IGNORED', T, async (t) => {
  await withApp(t, { script: 'worker.test.js' }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/plain', '/'), [ACK, ACK]);
    for (const route of ['/w', '/e']) {
      const [a, b] = await window(control, port, `s${route}`, route);
      assert.strictEqual(a, ACK);
      assert.match(b, /^IGNORED proto=2 the app ran 1 worker thread\(s\) during the test/, route);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(await window(control, port, 's/after', '/'), [ACK, ACK], 'once the workers are gone, a window is taken');
    await agent.until(() => agent.records.length === 2);
    assert.deepStrictEqual(agent.records.map((r) => r.id), ['s/plain', 's/after']);
  });
});

test('fail closed: another inspector client that stops the Profiler cuts the windows', T, async (t) => {
  await withApp(t, { script: 'inspect.test.js' }, async ({ agent, port, app, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/1', '/a'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    assert.strictEqual(agent.records[0].windowCut, true, JSON.stringify(agent.records[0]));
    assert.match(app.stderr(), /V8 left precise coverage/);
  });
});

test('required twice, by two paths: one adapter', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.dirname(REGISTER);
  const copy = path.join(dir, 'copy');
  fs.cpSync(src, copy, { recursive: true, filter: (p) => !path.relative(src, p).startsWith('test') });
  await withApp(t, { requires: [REGISTER, path.join(copy, 'register.js')] }, async ({ app, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/1', null), [ACK, ACK]);
    assert.ok(!/another process serves/.test(app.stderr()), app.stderr());
  });
});

test('a live owner keeps the socket', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const control = path.join(dir, 'control.sock');
  const owner = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => c.end('ACK proto=2 owner\n'));
  });
  await new Promise((r) => owner.listen(control, r));
  const app = startApp({ dir });
  try {
    await app.port;
    const deadline = Date.now() + 5000;
    while (!/another process serves/.test(app.stderr()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.match(app.stderr(), /another process serves .*control\.sock: this process \(pid \d+\) is not measured/);
    assert.strictEqual(await command(control, 'START s/1'), 'ACK proto=2 owner');
    assert.ok(fs.existsSync(path.join(dir, 'control.sock.peers', String(app.child.pid))), 'it marks itself a peer');
  } finally {
    await app.stop();
    await new Promise((r) => owner.close(r));
  }
});

test('a stale socket is replaced; a path that is no socket is never removed', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const control = path.join(dir, 'control.sock');
  // A stale socket: its process was killed while it listened.
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(control)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert.ok(fs.lstatSync(control).isSocket());
  await withApp(t, { dir }, async ({ port, control: c }) => {
    assert.deepStrictEqual(await window(c, port, 's/1', null), [ACK, ACK]);
  });
  // A plain file: left as it is, and the app is not measured.
  const dir2 = tmpDir();
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const file = path.join(dir2, 'control.sock');
  fs.writeFileSync(file, 'precious');
  const app = startApp({ dir: dir2 });
  try {
    await app.port;
    const deadline = Date.now() + 5000;
    while (!/is not a socket/.test(app.stderr()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.match(app.stderr(), /control\.sock is not a socket: it is left as it is, and this process is not measured/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'precious');
  } finally {
    await app.stop();
  }
});

test('not the app: a process whose main script is outside the root binds nothing', T, async (t) => {
  const dir = tmpDir();
  const elsewhere = tmpDir();
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); });
  for (const env of [{ KEPLOY_APP_SOURCE_DIR: elsewhere }, { KEPLOY_COVERAGE: '0' }]) {
    const app = startApp({ dir, env });
    try {
      await app.port;
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!fs.existsSync(path.join(dir, 'control.sock')));
    } finally {
      await app.stop();
    }
  }
});

test('the control socket goes with the app when it exits', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = startApp({ dir, script: 'exits.test.js' });
  await app.port;
  await waitFor(path.join(dir, 'control.sock'));
  await new Promise((r) => (app.child.exitCode !== null ? r() : app.child.on('exit', r)));
  assert.ok(!fs.existsSync(path.join(dir, 'control.sock')));
  assert.ok(!fs.existsSync(path.join(dir, 'control.sock.owner')));
});

test('an ES module app: its file: URLs map to its files', T, async (t) => {
  const cwd = path.join(__dirname, 'fixtures', 'esm');
  await withApp(t, { cwd, script: 'server.mjs' }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/hi', '/hi'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    assert.deepStrictEqual(lines(agent.records[0]), { id: 's/hi', executedLinesByFile: { 'greet.mjs': [1, 2, 3], 'server.mjs': [6] } });
  });
});

test('the main script: only one under the root, not under node_modules, is the app', () => {
  const { mainInRoot } = require('../lib/agent');
  assert.strictEqual(mainInRoot('/r', '/r/dist/main.js'), true);
  assert.strictEqual(mainInRoot('/r', '/r/node_modules/npm/bin/npm-cli.js'), false);
  assert.strictEqual(mainInRoot('/r', '/x/main.js'), false);
  assert.strictEqual(mainInRoot('/r', ''), false);
});

test('a file whose mtime is ahead of the app\'s clock is measured (KEPLOY_PROVEN sets the clock back)', T, async (t) => {
  const cwd = tmpDir();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, 'fixtures', 'esm'), cwd, { recursive: true });
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  for (const f of ['server.mjs', 'greet.mjs']) fs.utimesSync(path.join(cwd, f), future, future);
  await withApp(t, { cwd, script: 'server.mjs' }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/hi', '/hi'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    assert.deepStrictEqual(lines(agent.records[0]), { id: 's/hi', executedLinesByFile: { 'greet.mjs': [1, 2, 3], 'server.mjs': [6] } });
  });
});

test('a root script the table does not hold cuts the window it runs in, and is named', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const s = require('http').createServer((q, r) => {",
    "  if (q.url === '/new') {",
    "    fs.writeFileSync(path.join(__dirname, 'later.js'), 'module.exports = () => 7;\\n');",
    "    r.end(String(require('./later.js')()));",
    '    return;',
    '  }',
    "  r.end('x');",
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/plain', '/'), [ACK, ACK]);
    assert.deepStrictEqual(await window(control, port, 's/new', '/new'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 2);
    assert.strictEqual(agent.records[0].windowCut, undefined);
    assert.strictEqual(agent.records[1].windowCut, true, JSON.stringify(agent.records[1]));
    assert.match(app.stderr(), /later\.js ran, and the build table does not hold it/);
  });
});

test('a peer process of the app: every window is IGNORED while it lives, whatever lines it ran', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await withApp(t, { dir }, async ({ port, control }) => {
    const peer = startApp({ dir });
    try {
      await peer.port;
      const mark = path.join(dir, 'control.sock.peers', String(peer.child.pid));
      assert.ok(fs.existsSync(mark), 'marked at its preload');
      const re = /^IGNORED proto=2 the app serves requests in other processes \(workers, pids \d+\) that keploy cannot measure; run one process/;
      assert.match((await window(control, port, 's/empty', null))[1], re);
      assert.match((await window(control, port, 's/a', '/a'))[1], re, 'a window that ran the app\'s lines too');
    } finally {
      await peer.stop();
    }
    // Its mark stays after it exits; the owner prunes it at the next START.
    assert.deepStrictEqual(await window(control, port, 's/gone', '/a'), [ACK, ACK]);
  });
});

test('a peer forked for one request that exits before END: the window is IGNORED', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.js'), "'use strict';\nprocess.exit(0);\n");
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const { fork } = require('child_process');",
    "const s = require('http').createServer((q, r) => {",
    "  if (q.url === '/fork') {",
    "    fork(require('path').join(__dirname, 'job.js')).once('exit', () => r.end('done'));",
    '    return;',
    '  }',
    "  r.end('x');",
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/plain', '/'), [ACK, ACK]);
    const [a, b] = await window(control, port, 's/fork', '/fork');
    assert.strictEqual(a, ACK);
    assert.match(b, /^IGNORED proto=2 the app serves requests in other processes/);
    assert.deepStrictEqual(await window(control, port, 's/after', '/'), [ACK, ACK], 'the dead mark is pruned at the next START');
  });
});

test('a peers dir that is not a shared sticky 1777 dir: no peer is trusted, the owner fails closed', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'control.sock.peers'), { mode: 0o755 });
  fs.chmodSync(path.join(dir, 'control.sock.peers'), 0o755);
  await withApp(t, { dir }, async ({ port, control }) => {
    const [a, b] = await window(control, port, 's/1', '/a');
    assert.strictEqual(a, ACK);
    assert.match(b, /^IGNORED proto=2 .*control\.sock\.peers is not a shared sticky dir \(1777\)/);
  });
});

test('a template engine\'s script (an EJS sourceURL) is no app script the table lacks: no cut', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'views'));
  fs.writeFileSync(path.join(root, 'views/x.ejs'), '<p><%= name %></p>\n');
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const path = require('path');",
    "const render = new Function('name', 'return `<p>${name}</p>`;\\n//# sourceURL=' + path.join(__dirname, 'views/x.ejs'));",
    "const s = require('http').createServer((q, r) => {",
    "  r.end(render('n'));",
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/v', '/'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    assert.strictEqual(agent.records[0].windowCut, undefined, JSON.stringify(agent.records[0]));
    assert.deepStrictEqual(agent.records[0].executedLinesByFile, { 'main.js': [5] });
    assert.ok(!/x\.ejs ran/.test(app.stderr()), app.stderr());
  });
});

test('a script whose unit is not measured ran: the record names it in classMismatch', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'min.js'), `exports.f=function(){return 1};${'var z=0;'.repeat(300)}\n`);
  fs.writeFileSync(path.join(root, 'main.js'), "'use strict';\nconst m = require('./min.js');\nconst s = require('http').createServer((q, r) => r.end(String(q.url === '/m' ? m.f() : 0)));\ns.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));\n");
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/plain', '/'), [ACK, ACK]);
    assert.deepStrictEqual(await window(control, port, 's/m', '/m'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 2);
    assert.strictEqual(agent.records[0].classMismatch, undefined, JSON.stringify(agent.records[0]));
    assert.deepStrictEqual(agent.records[1].classMismatch, ['min.js']);
  });
});

test('an extensionless main script (bin/www) is a unit of the table, and measured', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/www'), "#!/usr/bin/env node\n'use strict';\nconst s = require('http').createServer((q, r) => {\n  r.end('www');\n});\ns.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));\n");
  await withApp(t, { cwd: root, script: 'bin/www', dir: tmpDir() }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/w', '/'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    assert.deepStrictEqual(lines(agent.records[0]), { id: 's/w', executedLinesByFile: { 'bin/www': [4] } });
  });
});

test('a CommonJS file with a BOM: V8 counts the BOM, and the lines are still right', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'bom.js'), '\ufeff' + [
    "'use strict';",
    'function pick(k) {',
    '  switch (k) {',
    "    case 'a':",
    '      return 1;',
    "    case 'b':",
    '      return 2;',
    '    default:',
    '      return 0;',
    '  }',
    '}',
    "const s = require('http').createServer((q, r) => r.end(String(pick(q.url.slice(1)))));",
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'bom.js', dir: tmpDir() }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/b', '/b'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    const lines = agent.records[0].executedLinesByFile['bom.js'];
    // Read one character early (the BOM not counted), the header and the
    // case line fall in the ranges before them.
    for (const l of [2, 6, 7]) assert.ok(lines.includes(l), `bom.js:${l} ran: ${JSON.stringify(lines)}`);
    for (const l of [5, 9]) assert.ok(!lines.includes(l), `bom.js:${l} did not run: ${JSON.stringify(lines)}`);
  });
});

test('a root preload that came before keploy\'s: held not measured, every other file measured, no window cut', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(APP, root, { recursive: true, preserveTimestamps: true });
  fs.writeFileSync(path.join(root, 'instrument.js'), [
    "'use strict';",
    "const http = require('http');",
    'const emit = http.Server.prototype.emit;',
    'function sample(name) {',
    "  return name === 'request';",
    '}',
    'http.Server.prototype.emit = function (name, ...args) {',
    '  sample(name);',
    '  return emit.call(this, name, ...args);',
    '};',
  ].join('\n'));
  await withApp(t, { cwd: root, requires: [path.join(root, 'instrument.js'), REGISTER], dir: tmpDir() }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/a', '/a'), [ACK, ACK]);
    assert.strictEqual(await command(control, 'TABLE'), ACK);
    await agent.until(() => agent.records.length === 1 && agent.parts.probes);
    const r = agent.records[0];
    assert.strictEqual(r.windowCut, undefined, JSON.stringify(r));
    assert.deepStrictEqual(r.executedLinesByFile['lib.js'], [4, 5, 6]);
    assert.ok(!r.executedLinesByFile['instrument.js']);
    const units = agent.parts.table.payload.toString().trimEnd().split('\n').map((l) => JSON.parse(l));
    const ins = units.find((u) => u.path === 'instrument.js');
    assert.deepStrictEqual([ins.state, ins.reason], ['not_measured', { code: 'analyzer_failed' }]);
  });
});

const [NODE_MAJ, NODE_MIN] = process.versions.node.split('.').map(Number);
test('Node\'s own TypeScript (type stripping): not measured, with the reason', { ...T, skip: NODE_MAJ < 22 || (NODE_MAJ === 22 && NODE_MIN < 6) ? 'this Node has no type stripping' : false }, async (t) => {
  const [maj, min] = [NODE_MAJ, NODE_MIN];
  const cwd = path.join(__dirname, 'fixtures', 'ts');
  const nodeArgs = maj === 22 || (maj === 23 && min < 6) ? ['--experimental-strip-types', '--no-warnings'] : [];
  await withApp(t, { cwd, script: 'main.ts', nodeArgs }, async ({ agent, port, control }) => {
    const [a] = await window(control, port, 's/1', '/');
    assert.match(a, /^IGNORED proto=2 the app is not measured: Node's built-in TypeScript is not measured yet \(main\.ts\): run the compiled JS with its source maps/);
    await agent.until(() => agent.indexes.length === 1);
    assert.strictEqual(agent.indexes[0].build, '');
    assert.strictEqual(agent.records.length, 0);
  });
});

test('a process whose main script is outside the root (a queue\'s sandboxed processor, node -e) that runs app code: the window is IGNORED', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/fakebull'), { recursive: true });
  // The Bull shape: a master in node_modules forks, then requires the app's processor.
  fs.writeFileSync(path.join(root, 'node_modules/fakebull/master.js'), "'use strict';\nrequire(process.argv[2]);\nprocess.exit(0);\n");
  fs.writeFileSync(path.join(root, 'job.js'), "'use strict';\nmodule.exports = 6 * 7;\n");
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const path = require('path');",
    "const os = require('os');",
    "const { fork, spawn } = require('child_process');",
    "const job = path.join(__dirname, 'job.js');",
    "const s = require('http').createServer((q, r) => {",
    "  if (q.url === '/bull') {",
    "    fork(path.join(__dirname, 'node_modules/fakebull/master.js'), [job]).once('exit', () => r.end('bull'));",
    '    return;',
    '  }',
    "  if (q.url === '/e') {",
    "    spawn(process.execPath, [...process.execArgv, '-e', `require(${JSON.stringify(job)})`], { cwd: os.tmpdir(), stdio: 'ignore' }).once('exit', () => r.end('e'));",
    '    return;',
    '  }',
    "  r.end('x');",
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/plain', '/'), [ACK, ACK]);
    for (const route of ['/bull', '/e']) {
      const [a, b] = await window(control, port, `s${route}`, route);
      assert.strictEqual(a, ACK);
      assert.match(b, /^IGNORED proto=2 the app serves requests in other processes/, route);
      assert.deepStrictEqual(await window(control, port, `s${route}-after`, '/'), [ACK, ACK], `${route}: its dead mark is pruned at the next START`);
    }
  });
});

test('an ES module loader hook: a module whose length V8 does not report is sent as classMismatch', T, async (t) => {
  const cwd = tmpDir();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, 'fixtures', 'esm'), cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'hooked.mjs'), [
    "import { register } from 'node:module';",
    "register('data:text/javascript,export async function load(u, c, n) { return n(u, c); }');",
    "await import('./server.mjs');",
  ].join('\n'));
  await withApp(t, { cwd, script: 'hooked.mjs' }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/hi', '/hi'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    const r = agent.records[0];
    assert.ok((r.classMismatch || []).includes('greet.mjs'), JSON.stringify(r));
    assert.ok(!r.executedLinesByFile['greet.mjs']);
  });
});

test('a request still being answered at END (keploy stopped waiting): the window is cut', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const s = require('http').createServer((q, r) => {",
    "  if (q.url === '/late') {",
    "    setTimeout(() => r.end('late'), 400);",
    '    return;',
    '  }',
    "  r.end('x');",
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, control }) => {
    assert.strictEqual(await command(control, 'START s/late'), ACK);
    const late = get(port, '/late');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(await command(control, 'END s/late'), ACK);
    await late;
    assert.deepStrictEqual(await window(control, port, 's/next', '/'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 2);
    assert.strictEqual(agent.records[0].windowCut, true, JSON.stringify(agent.records[0]));
    assert.strictEqual(agent.records[1].windowCut, undefined, JSON.stringify(agent.records[1]));
  });
});

test('an ES module loader by --experimental-loader, or module.register called by a CommonJS main: classMismatch', T, async (t) => {
  const hook = 'data:text/javascript,export async function load(u, c, n) { return n(u, c); }';
  const cases = [
    { name: '--experimental-loader', script: 'server.mjs', nodeArgs: ['--experimental-loader', hook, '--no-warnings'] },
    { name: 'module.register in a CommonJS main', script: 'hook.cjs', nodeArgs: [] },
  ];
  for (const c of cases) {
    const cwd = tmpDir();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.cpSync(path.join(__dirname, 'fixtures', 'esm'), cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'hook.cjs'), `'use strict';\nrequire('node:module').register(${JSON.stringify(hook)});\nimport('./server.mjs');\n`);
    await withApp(t, { cwd, script: c.script, nodeArgs: c.nodeArgs }, async ({ agent, port, control }) => {
      assert.deepStrictEqual(await window(control, port, 's/hi', '/hi'), [ACK, ACK], c.name);
      await agent.until(() => agent.records.length === 1);
      const r = agent.records[0];
      assert.ok((r.classMismatch || []).includes('greet.mjs'), `${c.name}: ${JSON.stringify(r)}`);
      assert.ok(!r.executedLinesByFile['greet.mjs'], c.name);
    });
  }
});

test('records carry pid, build and fileHashes; the first START sends the STARTUP record', T, async (t) => {
  await withApp(t, {}, async ({ agent, port, app, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/a', '/a'), [ACK, ACK]);
    assert.deepStrictEqual(await window(control, port, 's/b', '/b'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 2 && agent.indexes.length === 1);
    const [a] = agent.records;
    assert.strictEqual(a.pid, app.child.pid);
    assert.strictEqual(a.build, agent.indexes[0].build);
    const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(APP, f))).digest('hex');
    assert.deepStrictEqual(a.fileHashes, { 'lib.js': sha('lib.js'), 'server.js': sha('server.js') });
    whole(a);
    assert.strictEqual(agent.startups.length, 1, 'once per process');
    const st = agent.startups[0];
    assert.deepStrictEqual(Object.keys(st), ['kind', 'v', 'pid', 'build', 'executedLinesByFile', 'fileHashes']);
    assert.deepStrictEqual([st.kind, st.v, st.pid, st.build], ['startup', 1, app.child.pid, a.build]);
    // The app's top level ran before the first window: never a test's.
    assert.deepStrictEqual(st.executedLinesByFile['lib.js'], [1, 14]);
    assert.ok(st.executedLinesByFile['server.js'].includes(25));
    assert.ok(!a.executedLinesByFile['server.js'].includes(25));
  });
});

test('timers and consumers: work that is not the test\'s in its window makes it partial', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const net = require('net');",
    'let ticks = 0;',
    'let job = null;',
    "const feed = net.createServer((c) => c.end('m')).listen(0, '127.0.0.1');",
    "const s = require('http').createServer((q, r) => {",
    "  if (q.url === '/job') {",
    '    job = setInterval(() => {',
    '      ticks++;',
    '    }, 20);',
    "  } else if (q.url === '/stop') {",
    '    clearInterval(job);',
    "  } else if (q.url === '/later') {",
    '    setTimeout(() => {',
    '      ticks++;',
    '    }, 300);',
    "  } else if (q.url === '/consume') {",
    "    const c = net.connect(feed.address().port, '127.0.0.1');",
    '    c.on(\'data\', () => { ticks++; });',
    "  } else if (q.url === '/own') {",
    '    setTimeout(() => r.end(String(ticks)), 10);',
    '    return;',
    '  }',
    "  r.end('ok');",
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    const rec = async (id, route, wait = 0, before = 0) => {
      const n = agent.records.length;
      assert.strictEqual(await command(control, `START ${id}`), ACK);
      if (before) await new Promise((r) => setTimeout(r, before));
      if (route) await get(port, route);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      assert.strictEqual(await command(control, `END ${id}`), ACK);
      await agent.until(() => agent.records.length === n + 1);
      return agent.records[n];
    };
    const why = () => app.stderr().split('\n').filter((l) => /partial:|pending at END/.test(l)).join('\n');
    assert.strictEqual((await rec('s/plain', '/')).partial, undefined, 'a plain request' + why());
    assert.strictEqual((await rec('s/own', '/own')).partial, undefined, 'a timer the request set and that ran' + why());
    assert.match((await rec('s/later', '/later')).partial || '', /work the test's requests started \(Timeout\) was still running at END/);
    await new Promise((r) => setTimeout(r, 350));
    assert.match((await rec('s/job', '/job')).partial || '', /was still running at END/, 'an interval it set');
    assert.match((await rec('s/during', null, 100)).partial || '', /work that is not the test's \([^)]*Timeout[^)]*\) ran app code in its window \(main\.js\)/, 'an interval set before the window');
    // The interval the s/job test set keeps firing in the next windows: they
    // are partial until a test clears it.
    // (The window waits before the request, so the interval fires in it
    // for sure: it fires every 20 ms.)
    assert.match((await rec('s/stop', '/stop', 0, 100)).partial || '', /ran app code in its window \(main\.js\)/);
    assert.strictEqual((await rec('s/after-stop', '/')).partial, undefined, 'once the interval is cleared');
    // A socket the test opens and that gets its data in the window is the test's.
    assert.strictEqual((await rec('s/consume', '/consume', 100)).partial, undefined);
  });
});

test('a preload that came before keploy\'s ran in the test: the record is partial', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(APP, root, { recursive: true, preserveTimestamps: true });
  fs.writeFileSync(path.join(root, 'instrument.js'), "'use strict';\nconst http = require('http');\nconst emit = http.Server.prototype.emit;\nfunction sample(name) {\n  return name === 'request';\n}\nhttp.Server.prototype.emit = function (name, ...args) {\n  sample(name);\n  return emit.call(this, name, ...args);\n};\n");
  await withApp(t, { cwd: root, requires: [path.join(root, 'instrument.js'), REGISTER], dir: tmpDir() }, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/a', '/a'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    assert.match(agent.records[0].partial || '', /instrument\.js ran in the test, and it was loaded before keploy's coverage preload/);
  });
});

test('a peers dir is shared (1777, sticky), made so by the first process of the app', T, async (t) => {
  await withApp(t, {}, async ({ dir }) => {
    const st = fs.statSync(path.join(dir, 'control.sock.peers'));
    assert.strictEqual(st.mode & 0o7777, 0o1777);
  });
});

test('an ES module of the app loaded by a process whose main script is outside the root: the window is IGNORED', T, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/esmq'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/esmq/master.js'), "'use strict';\nimport(require('url').pathToFileURL(process.argv[2]).href).then(() => process.exit(0));\n");
  fs.writeFileSync(path.join(root, 'job.mjs'), 'export default 6 * 7;\n');
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const path = require('path');",
    "const { fork } = require('child_process');",
    "const s = require('http').createServer((q, r) => {",
    "  if (q.url === '/esm') {",
    "    fork(path.join(__dirname, 'node_modules/esmq/master.js'), [path.join(__dirname, 'job.mjs')]).once('exit', () => r.end('esm'));",
    '    return;',
    '  }',
    "  r.end('x');",
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/plain', '/'), [ACK, ACK]);
    const [a, b] = await window(control, port, 's/esm', '/esm');
    assert.strictEqual(a, ACK);
    assert.match(b, /^IGNORED proto=2 the app serves requests in other processes/);
  });
});

test('a queue consumer opened at startup that gets a message in a window: partial', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const net = require('net');",
    'let got = 0;',
    'const feed = net.createServer((c) => {',
    "  const i = setInterval(() => c.write('m'), 30);",
    "  c.on('close', () => clearInterval(i));",
    "  c.on('error', () => {});",
    "}).listen(0, '127.0.0.1', () => {",
    "  const sub = net.connect(feed.address().port, '127.0.0.1');",
    "  sub.on('data', () => {",
    '    got++;',
    '  });',
    "  const s = require('http').createServer((q, r) => r.end(String(got)));",
    "  s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
    '});',
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    assert.strictEqual(await command(control, 'START s/1'), ACK);
    await get(port, '/');
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(await command(control, 'END s/1'), ACK);
    await agent.until(() => agent.records.length === 1);
    assert.match(agent.records[0].partial || '', /work that is not the test's \([^)]*\) ran app code in its window \(main\.js\)/, app.stderr().split('\n').filter((l) => /partial|bracket/.test(l)).slice(0, 20).join('\n'));
  });
});

// A pooled "DB": a socket to a local echo server opened at startup, with a
// promise driver (in node_modules) or a callback driver that calls the app's
// callback inside the socket's data callback.
function dbApp(root) {
  fs.mkdirSync(path.join(root, 'node_modules/fakedb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/fakedb/index.js'), [
    "'use strict';",
    "const net = require('net');",
    'exports.connect = (port) => {',
    "  const sock = net.connect(port, '127.0.0.1');",
    '  const waiting = [];',
    "  sock.on('data', (d) => { for (const _ of String(d)) { const w = waiting.shift(); if (w) w(); } });",
    '  return {',
    "    query: () => new Promise((r) => { waiting.push(r); sock.write('q'); }),",
    "    queryCb: (cb) => { waiting.push(cb); sock.write('q'); },",
    '  };',
    '};',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const net = require('net');",
    "const fakedb = require('fakedb');",
    "const echo = net.createServer((c) => c.on('data', (d) => c.write(d))).listen(0, '127.0.0.1', () => {",
    '  const db = fakedb.connect(echo.address().port);',
    "  const s = require('http').createServer(async (q, r) => {",
    "    if (q.url === '/pool') {",
    '      for (let i = 0; i < 20; i++) {',
    '        await db.query();',
    '      }',
    "      r.end('pool');",
    "    } else if (q.url === '/cb') {",
    '      db.queryCb(() => {',
    "        r.end('cb');",
    '      });',
    "    } else if (q.url === '/body' || q.url === '/put') {",
    "      let body = '';",
    "      q.on('data', (d) => { body += d; });",
    "      q.on('end', () => {",
    '        setTimeout(() => {',
    '          r.end(String(body.length));',
    '        }, 5);',
    '      });',
    "    } else if (q.url === '/two') {",
    "      require('http').get({ host: '127.0.0.1', port: s.address().port, path: '/' }, (x) => { x.resume(); x.on('end', () => r.end('two')); });",
    "    } else if (q.url === '/child') {",
    "      require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });",
    "      r.end('child');",
    "    } else if (q.url === '/sock') {",
    "      net.connect(echo.address().port, '127.0.0.1');",
    "      r.end('fs');",
    '    } else {',
    "      r.end('x');",
    '    }',
    '  });',
    "  s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
    '});',
  ].join('\n'));
}

function send(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = require('http').request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve(b));
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('the delta rule: a pooled socket with a promise driver is the test\'s; a callback driver, a second request, pending work are partial', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dbApp(root);
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    const why = () => app.stderr().split('\n').filter((l) => /partial:|pending at END/.test(l)).join('\n');
    const rec = async (id, method, route, body) => {
      const n = agent.records.length;
      assert.strictEqual(await command(control, `START ${id}`), ACK);
      await send(port, method, route, body);
      assert.strictEqual(await command(control, `END ${id}`), ACK);
      await agent.until(() => agent.records.length === n + 1);
      return agent.records[n];
    };
    for (let i = 0; i < 3; i++) {
      const r = await rec(`s/pool${i}`, 'GET', '/pool');
      assert.strictEqual(r.partial, undefined, JSON.stringify(r) + why());
      assert.ok(r.executedLinesByFile['main.js'].includes(9) && r.executedLinesByFile['main.js'].includes(11), JSON.stringify(r));
    }
    const cb = await rec('s/cb', 'GET', '/cb');
    assert.match(cb.partial || '', /work that is not the test's \([^)]*\) ran app code in its window \(main\.js\)/);
    assert.ok(!(cb.executedLinesByFile['main.js'] || []).includes(14), 'the callback\'s app line is never credited');
    for (const [m, route] of [['POST', '/body'], ['PUT', '/put']]) {
      const r = await rec(`s/${m}`, m, route, JSON.stringify({ a: 'x'.repeat(5000) }));
      assert.strictEqual(r.partial, undefined, `${m}: ${JSON.stringify(r)}${why()}`);
      assert.ok(r.executedLinesByFile['main.js'].includes(21), `${m}: the body's timer callback is the test's: ${JSON.stringify(r)}`);
    }
    assert.match((await rec('s/two', 'GET', '/two')).partial || '', /more than one request ran in the test's window/);
    // Work the test started that cannot be done by END (a child process, a
    // socket it opened and left open): deterministic, unlike a fast file read.
    assert.match((await rec('s/child', 'GET', '/child')).partial || '', /work the test's requests started \(PROCESSWRAP\) was still running at END/);
    // A socket the test opened and left open is no work by itself.
    assert.strictEqual((await rec('s/sock', 'GET', '/sock')).partial, undefined);
  });
});

test('Node 18: no async tracking, and every window is partial with the end-of-life reason', { ...T, skip: EOL ? false : 'Node 20+ has async tracking' }, async (t) => {
  await withApp(t, {}, async ({ agent, port, control }) => {
    assert.deepStrictEqual(await window(control, port, 's/a', '/a'), [ACK, ACK]);
    await agent.until(() => agent.records.length === 1);
    assert.match(agent.records[0].partial, EOL_RE);
    assert.deepStrictEqual(agent.records[0].executedLinesByFile['lib.js'], [4, 5, 6]);
  });
});

test('a test that dies early leaves no process of its app behind', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = `kcov-orphan-${process.pid}-${Date.now()}`;
  fs.writeFileSync(path.join(dir, 'spawner.js'), [
    "'use strict';",
    "const { spawn } = require('child_process');",
    `spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}], { stdio: 'ignore' });`,
    "process.stdout.write('PORT 1\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  // A test process that starts the app (which starts a child) and dies.
  const runner = [
    `const h = require(${JSON.stringify(path.join(__dirname, 'helpers.js'))});`,
    `const app = h.startApp({ dir: ${JSON.stringify(dir)}, cwd: ${JSON.stringify(dir)}, script: 'spawner.js', requires: [] });`,
    "app.port.then(() => setTimeout(() => { throw new Error('the test died'); }, 300));",
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', runner], { encoding: 'utf8', timeout: 20000 });
  assert.match(r.stderr, /the test died/);
  await new Promise((res) => setTimeout(res, 500));
  const left = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
    try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(marker); } catch { return false; }
  });
  assert.deepStrictEqual(left, [], 'no process of the app is left');
});

// An app with the outbound work a real handler does: a keep-alive HTTP
// call, compression, fs.promises, AbortSignal.timeout, a pool connection
// opened on first use, and work after the response (an audit query, a
// crypto job).
function workApp(root) {
  fs.mkdirSync(path.join(root, 'node_modules/fakedb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/fakedb/index.js'), [
    "'use strict';",
    "const net = require('net');",
    'exports.connect = (port) => {',
    "  const sock = net.connect(port, '127.0.0.1');",
    '  const waiting = [];',
    "  sock.on('data', (d) => { for (const _ of String(d)) { const w = waiting.shift(); if (w) w(); } });",
    "  return { query: (q = 'q') => new Promise((r) => { waiting.push(r); sock.write(q); }) };",
    '};',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const net = require('net');",
    "const http = require('http');",
    "const zlib = require('zlib');",
    "const fsp = require('fs').promises;",
    "const crypto = require('crypto');",
    "const fakedb = require('fakedb');",
    '// An echo "DB" that answers at once, and one that answers after 200 ms.',
    "const echo = net.createServer((c) => c.on('data', (d) => c.write(d))).listen(0, '127.0.0.1');",
    "const slow = net.createServer((c) => c.on('data', (d) => setTimeout(() => c.write(d), 200))).listen(0, '127.0.0.1');",
    "// The upstream is another service: a process of its own, with no preload.",
    "const up = require('child_process').spawn(process.execPath, ['-e', \"const s = require('http').createServer((q, r) => r.end('up')).listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port)))\"], { stdio: ['ignore', 'pipe', 'inherit'] });",
    'let upPort = 0;',
    'const agent = new http.Agent({ keepAlive: true });',
    'let db = null;',
    'let slowdb = null;',
    'let lazy = null;',
    "const call = () => new Promise((res) => http.get({ host: '127.0.0.1', port: upPort, agent }, (x) => { x.resume(); x.on('end', res); }));",
    "echo.on('listening', () => { db = fakedb.connect(echo.address().port); });",
    "slow.on('listening', () => { slowdb = fakedb.connect(slow.address().port); });",
    'const s = http.createServer(async (q, r) => {',
    "  if (q.url === '/ka') {",
    '    await call();',
    "    r.end('ka');",
    "  } else if (q.url === '/gz') {",
    "    zlib.gzip(Buffer.alloc(20000, 'x'), (e, b) => {",
    "      r.setHeader('content-encoding', 'gzip');",
    '      r.end(b);',
    '    });',
    "  } else if (q.url === '/fsp') {",
    '    const b = await fsp.readFile(__filename);',
    '    r.end(String(b.length));',
    "  } else if (q.url === '/abort') {",
    '    const sig = AbortSignal.timeout(5000);',
    '    r.end(String(sig.aborted));',
    "  } else if (q.url === '/lazy') {",
    '    if (!lazy) {',
    '      lazy = fakedb.connect(echo.address().port);',
    '    }',
    '    await lazy.query();',
    "    r.end('lazy');",
    "  } else if (q.url === '/audit') {",
    "    r.end('ok');",
    '    await db.query();',
    '    audited();',
    "  } else if (q.url === '/slowaudit') {",
    "    r.end('ok');",
    '    await slowdb.query();',
    '    audited();',
    "  } else if (q.url === '/pbkdf') {",
    "    r.end('ok');",
    "    crypto.pbkdf2('pw', 'salt', 1, 32, 'sha256', () => {",
    '      audited();',
    '    });',
    "  } else if (q.url === '/gc') {",
    '    global.gc();',
    '    global.gc();',
    "    r.end('gc');",
    '  } else {',
    "    r.end('x');",
    '  }',
    '});',
    'function audited() {',
    '  return 1;',
    '}',
    "up.stdout.once('data', (d) => { upPort = Number(String(d)); s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`)); });",
  ].join('\n'));
}

test('pending is work that will still run code: keep-alive calls, compression, fs.promises, AbortSignal, a lazy pool are no partial', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  workApp(root);
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    const why = () => app.stderr().split('\n').filter((l) => /partial:|pending at END/.test(l)).join('\n');
    const rec = async (id, route) => {
      const n = agent.records.length;
      assert.strictEqual(await command(control, `START ${id}`), ACK);
      await get(port, route);
      assert.strictEqual(await command(control, `END ${id}`), ACK);
      await agent.until(() => agent.records.length === n + 1);
      return agent.records[n];
    };
    for (const route of ['/ka', '/ka', '/gz', '/fsp', '/abort', '/lazy', '/lazy', '/x']) {
      const r = await rec(`s${route}`, route);
      assert.strictEqual(r.partial, undefined, `${route}: ${JSON.stringify(r)} ${why()}`);
    }
    // Work after the response, done within the settle: its lines are the test's.
    const auditLine = fs.readFileSync(path.join(root, 'main.js'), 'utf8').split('\n').indexOf('  return 1;') + 1;
    const audit = await rec('s/audit', '/audit');
    assert.strictEqual(audit.partial, undefined, JSON.stringify(audit) + why());
    await new Promise((r) => setTimeout(r, 100));
    // Its line is the test's: in the record if it ran by END, else amended.
    assert.ok(audit.executedLinesByFile['main.js'].includes(auditLine) || agent.amends.some((a) => a.test === 's/audit'), `the audit: ${JSON.stringify(audit)} ${JSON.stringify(agent.amends)}`);
    const pb = await rec('s/pbkdf', '/pbkdf');
    assert.strictEqual(pb.partial, undefined, JSON.stringify(pb) + why());
    assert.ok(pb.executedLinesByFile['main.js'].includes(auditLine), `the crypto callback's line is credited: ${JSON.stringify(pb)}`);
    // Work after the response whose reply comes after END: not judged at
    // END (a promise); its app code after END amends the test.
    const sa = await rec('s/slowaudit', '/slowaudit');
    assert.strictEqual(sa.partial, undefined, JSON.stringify(sa));
    await agent.until(() => agent.amends.some((a) => a.test === 's/slowaudit'), 3000);
    assert.match(agent.amends.find((a) => a.test === 's/slowaudit').partial, /^work the test started ran app code after its end \(.*\): main\.js$/);
  });
});

test('pending resources are held weakly: compressed responses leave nothing behind after GC', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  workApp(root);
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir(), nodeArgs: ['--expose-gc'], env: { KEPLOY_COVERAGE_DEBUG: '1' } }, async ({ port, app, control }) => {
    const tagsNow = () => {
      const m = [...app.stderr().matchAll(/async tags (\d+)/g)];
      return Number(m[m.length - 1][1]);
    };
    const win = async (id, route) => {
      await command(control, `START ${id}`);
      await get(port, route);
      await command(control, `END ${id}`);
    };
    for (let i = 0; i < 20; i++) await win(`w/${i}`, '/gz');
    await win('w/gc0', '/gc');
    const base = tagsNow();
    for (let i = 0; i < 300; i++) await win(`z/${i}`, '/gz');
    await win('w/gc1', '/gc');
    await win('w/gc2', '/gc');
    const after = tagsNow();
    assert.ok(after <= base + 50, `async tags ${base} before 300 compressed responses, ${after} after GC`);
  });
});

test('should-fixes: a connection listener, nested scopes both ways, an app timer named resetCache', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/scoped'), { recursive: true });
  // A library (node_modules) that runs a callback in the scope of an async
  // resource it made at startup.
  fs.writeFileSync(path.join(root, 'node_modules/scoped/index.js'), [
    "'use strict';",
    "const { AsyncResource } = require('async_hooks');",
    "const res = new AsyncResource('LIBSCOPE');",
    'exports.run = (fn) => res.runInAsyncScope(fn);',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const http = require('http');",
    "const { AsyncResource } = require('async_hooks');",
    "const scoped = require('scoped');",
    'let conns = 0;',
    'function mark() {',
    '  return 1;',
    '}',
    'const s = http.createServer(async (q, r) => {',
    "  if (q.url === '/nested') {",
    '    mark();',
    '    scoped.run(() => 0);',
    '    mark();',
    "    r.end('nested');",
    "  } else if (q.url === '/inside') {",
    "    const mine = new AsyncResource('MINE');",
    '    scoped.run(() => mine.runInAsyncScope(() => {',
    '      mark();',
    '    }));',
    "    r.end('inside');",
    "  } else if (q.url === '/reset') {",
    '    setTimeout(function resetCache() {',
    '      mark();',
    '    }, 300);',
    "    r.end('reset');",
    '  } else {',
    "    r.end('x');",
    '  }',
    '});',
    "s.on('connection', () => {",
    '  conns++;',
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    const why = () => app.stderr().split('\n').filter((l) => /partial:|pending at END/.test(l)).join('\n');
    // A new connection per test, as keploy makes: its 'connection' listener is the test's.
    const fresh = (p) => new Promise((resolve, reject) => {
      require('http').get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    const rec = async (id, route) => {
      const n = agent.records.length;
      assert.strictEqual(await command(control, `START ${id}`), ACK);
      await fresh(route);
      assert.strictEqual(await command(control, `END ${id}`), ACK);
      await agent.until(() => agent.records.length === n + 1);
      return agent.records[n];
    };
    const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8').split('\n');
    const line = (text, from = 0) => src.indexOf(text, from) + 1;
    const c = await rec('s/conn', '/x');
    assert.strictEqual(c.partial, undefined, JSON.stringify(c) + why());
    assert.ok(c.executedLinesByFile['main.js'].includes(line('  conns++;')), 'the connection listener is credited');
    const n = await rec('s/nested', '/nested');
    assert.strictEqual(n.partial, undefined, JSON.stringify(n) + why());
    const ln = line('    mark();');
    assert.ok(n.executedLinesByFile['main.js'].includes(ln) && n.executedLinesByFile['main.js'].includes(line('    mark();', ln)), `lines before and after a foreign scope are the test's: ${JSON.stringify(n)}`);
    const i = await rec('s/inside', '/inside');
    assert.strictEqual(i.partial, undefined, JSON.stringify(i) + why());
    assert.ok(i.executedLinesByFile['main.js'].includes(line('      mark();')), `the test's own scope inside a foreign one is credited: ${JSON.stringify(i)}`);
    assert.match((await rec('s/reset', '/reset')).partial || '', /work the test's requests started \(Timeout\) was still running at END/, 'an app timer named resetCache is the app\'s');
  });
});

// The TLS row makes its certificate and key at test time (never a key in the
// repo), with openssl; with no openssl on PATH it is skipped.
const OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
test('an outbound TLS keep-alive call in a window is no partial', { ...TA, skip: TA.skip || (OPENSSL ? false : 'openssl is not on PATH: no certificate for the TLS row') }, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = path.join(root, 'key.pem');
  const cert = path.join(root, 'cert.pem');
  const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', key, '-out', cert], { encoding: 'utf8' });
  assert.strictEqual(g.status, 0, g.stderr);
  const upCode = `const fs = require('fs'); const s = require('https').createServer({ key: fs.readFileSync(${JSON.stringify(key)}), cert: fs.readFileSync(${JSON.stringify(cert)}) }, (q, r) => r.end('tls')).listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port)))`;
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const http = require('http');",
    "const https = require('https');",
    `const up = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(upCode)}], { stdio: ['ignore', 'pipe', 'inherit'] });`,
    'const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });',
    'let upPort = 0;',
    'const s = http.createServer(async (q, r) => {',
    "  await new Promise((res) => https.get({ host: '127.0.0.1', port: upPort, agent }, (x) => { x.resume(); x.on('end', res); }));",
    "  r.end('tls');",
    '});',
    "up.stdout.once('data', (d) => { upPort = Number(String(d)); s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`)); });",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    const why = () => app.stderr().split('\n').filter((l) => /partial:|pending at END/.test(l)).join('\n');
    for (const k of [1, 2]) {
      assert.deepStrictEqual(await window(control, port, `s/tls${k}`, '/'), [ACK, ACK]);
      await agent.until(() => agent.records.length === k);
      const r = agent.records[k - 1];
      assert.strictEqual(r.partial, undefined, `TLS keep-alive call ${k}: ${JSON.stringify(r)}${why()}`);
    }
  });
});

test('a pm2-runtime-like launcher in node_modules that loads the root config (require, import) does not make the tests IGNORED', T, async (t) => {
  for (const kind of ['require', 'import']) {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'node_modules/pm2like'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ecosystem.config.js'), "module.exports = { script: 'server.js' };\n");
    fs.writeFileSync(path.join(root, 'ecosystem.config.mjs'), "export default { script: 'server.js' };\n");
    fs.cpSync(APP, root, { recursive: true, filter: (p) => !p.includes('exits.test') });
    const load = kind === 'require'
      ? "const conf = require(require('path').join(process.cwd(), 'ecosystem.config.js'));"
      : "const conf = (await import(require('url').pathToFileURL(require('path').join(process.cwd(), 'ecosystem.config.mjs')).href)).default;";
    fs.writeFileSync(path.join(root, 'node_modules/pm2like/runtime.js'), [
      "'use strict';",
      '(async () => {',
      `  ${load}`,
      "  const child = require('child_process').fork(require('path').join(process.cwd(), conf.script), [], { stdio: 'inherit' });",
      "  process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });",
      '})();',
    ].join('\n'));
    await withApp(t, { cwd: root, script: 'node_modules/pm2like/runtime.js', dir: tmpDir() }, async ({ agent, port, control }) => {
      let ans;
      for (let i = 0; i < 20; i++) {
        ans = await window(control, port, `p/${kind}${i}`, '/a');
        if (ans[0] === ACK) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepStrictEqual(ans, [ACK, ACK], kind);
      await agent.until(() => agent.records.length >= 1);
      assert.deepStrictEqual(agent.records[agent.records.length - 1].executedLinesByFile['lib.js'], [4, 5, 6], kind);
    });
  }
});

test('after END: a never-settled promise and a Promise.race timeout are no partial; late app code of the test is amended', TA, async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/cbdb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/cbdb/index.js'), [
    "'use strict';",
    "const net = require('net');",
    'exports.connect = (port) => {',
    "  const sock = net.connect(port, '127.0.0.1');",
    '  const waiting = [];',
    "  sock.on('data', (d) => { for (const _ of String(d)) { const w = waiting.shift(); if (w) w(); } });",
    "  return { queryCb: (cb) => { waiting.push(cb); sock.write('q'); } };",
    '};',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'main.js'), [
    "'use strict';",
    "const net = require('net');",
    "const cbdb = require('cbdb');",
    "const slow = net.createServer((c) => c.on('data', (d) => setTimeout(() => c.write(d), 150))).listen(0, '127.0.0.1');",
    'let db = null;',
    "slow.on('listening', () => { db = cbdb.connect(slow.address().port); });",
    'function late() {',
    '  return 1;',
    '}',
    "const s = require('http').createServer(async (q, r) => {",
    "  if (q.url === '/never') {",
    '    const p = new Promise(() => {});',
    "    r.end(String(typeof p));",
    "  } else if (q.url === '/race') {",
    '    let timer;',
    "    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('t')), 5000); });",
    "    await Promise.race([Promise.resolve('fast'), timeout]);",
    '    clearTimeout(timer);',
    "    r.end('race');",
    "  } else if (q.url === '/cb') {",
    "    r.end('cb');",
    '    db.queryCb(() => {',
    '      late();',
    '    });',
    "  } else if (q.url === '/sock') {",
    "    const c = net.connect(slow.address().port, '127.0.0.1');",
    "    c.on('data', () => {",
    '      late();',
    '    });',
    "    c.write('x');",
    "    r.end('sock');",
    "  } else if (q.url === '/unref') {",
    '    setTimeout(() => {',
    '      late();',
    '    }, 100).unref();',
    "    r.end('unref');",
    "  } else if (q.url === '/refresh') {",
    '    const tm = setTimeout(() => {',
    '      late();',
    '    }, 60);',
    '    tm.unref();',
    '    tm.refresh();',
    "    r.end('refresh');",
    '  } else {',
    "    r.end('x');",
    '  }',
    '});',
    "s.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${s.address().port}\\n`));",
  ].join('\n'));
  await withApp(t, { cwd: root, script: 'main.js', dir: tmpDir() }, async ({ agent, port, app, control }) => {
    const rec = async (id, route) => {
      const n = agent.records.length;
      assert.strictEqual(await command(control, `START ${id}`), ACK);
      await get(port, route);
      const t0 = Date.now();
      assert.strictEqual(await command(control, `END ${id}`), ACK);
      const ms = Date.now() - t0;
      await agent.until(() => agent.records.length === n + 1);
      return [agent.records[n], ms];
    };
    const [nv, nms] = await rec('a/never', '/never');
    assert.strictEqual(nv.partial, undefined, JSON.stringify(nv));
    assert.ok(nms < 45, `END did not wait for the never-settled promise (${nms} ms)`);
    const [rc] = await rec('a/race', '/race');
    assert.strictEqual(rc.partial, undefined, JSON.stringify(rc));
    for (const route of ['/cb', '/sock', '/unref', '/refresh']) {
      const [r] = await rec(`a${route}`, route);
      assert.strictEqual(r.partial, undefined, `${route}: ${JSON.stringify(r)}`);
      await agent.until(() => agent.amends.some((a) => a.test === `a${route}`), 3000).catch(() => {});
      const am = agent.amends.find((a) => a.test === `a${route}`);
      assert.ok(am, `${route}: amended (${JSON.stringify(agent.amends)}) ${app.stderr().split('\n').filter((l) => /amend|partial/.test(l)).join(' | ')}`);
      assert.match(am.partial, /^work the test started ran app code after its end \(.*\): main\.js$/);
      assert.deepStrictEqual(Object.keys(am), ['kind', 'v', 'test', 'partial']);
    }
    assert.strictEqual(agent.amends.filter((a) => a.test === 'a/never' || a.test === 'a/race').length, 0, 'no amend for the clean tests');
  });
});
