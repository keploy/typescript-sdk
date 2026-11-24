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
const T = { timeout: 30000 };
const BUNDLE = path.join(__dirname, 'fixtures', 'bundle');

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
    assert.deepStrictEqual(Object.keys(a), ['id', 'executedLinesByFile']);
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
    assert.ok(fs.existsSync(path.join(dir, `control.sock.peers-${process.getuid()}`, String(app.child.pid))), 'it marks itself a peer');
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
    assert.deepStrictEqual(agent.records[0], { id: 's/hi', executedLinesByFile: { 'greet.mjs': [1, 2, 3], 'server.mjs': [6] } });
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
    assert.deepStrictEqual(agent.records[0], { id: 's/hi', executedLinesByFile: { 'greet.mjs': [1, 2, 3], 'server.mjs': [6] } });
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
      const mark = path.join(dir, `control.sock.peers-${process.getuid()}`, String(peer.child.pid));
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

test('a peers dir that is not this user\'s own 0700 dir: no peer is trusted, the owner fails closed', T, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, `control.sock.peers-${process.getuid()}`), { mode: 0o755 });
  fs.chmodSync(path.join(dir, `control.sock.peers-${process.getuid()}`), 0o755);
  await withApp(t, { dir }, async ({ port, control }) => {
    const [a, b] = await window(control, port, 's/1', '/a');
    assert.strictEqual(a, ACK);
    assert.match(b, /^IGNORED proto=2 .*control\.sock\.peers-\d+ is not this user's own 0700 dir/);
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
    assert.deepStrictEqual(agent.records[0], { id: 's/w', executedLinesByFile: { 'bin/www': [4] } });
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

test('Node\'s own TypeScript (type stripping): not measured, with the reason', T, async (t) => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 6)) return t.skip('this Node has no type stripping');
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
