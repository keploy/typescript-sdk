// Rows for the paths a real Jest run reaches only when Jest's rule for which
// tests run differs from the one this package reads at test_start, and for
// the environment it wraps: jest-circus's events, driven by hand against a
// fake agent. One agent for the file: the claim is once per process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const calls = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const b = JSON.parse(body);
    calls.push(req.url === '/agent/instance' ? `claim ${b.key}` : `${req.url.slice('/agent/scope/'.length)} ${b.file}::${b.name}${b.outcome ? ` ${b.outcome}` : ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/agent/instance' ? { v: 1, instance: 'run', timeFile: '' } : { v: 1, status: 'ok' }));
  });
});
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kj-scope-')));
const file = path.join(dir, 'a.test.js');
let withKeploy;

before(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  fs.writeFileSync(file, '');
  process.env.KEPLOY_MOCK_AGENT = `http://127.0.0.1:${srv.address().port}`;
  process.env.KEPLOY_MOCK_PROJECT = dir;
  delete process.env.KEPLOY_TEST_PID;
  ({ withKeploy } = await import('../dist/index.js'));
});
after(async () => {
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

// The environment it wraps, which records the events it saw.
class Base {
  constructor() { this.global = { process: { env: {} } }; this.seen = []; }
  async setup() {}
  async teardown() {}
  handleTestEvent(event) { this.seen.push(`${event.name} ${calls.length}`); }
}

async function env() {
  const E = withKeploy(Base);
  const e = new E({ globalConfig: {}, projectConfig: {} }, { testPath: file });
  await e.setup();
  return e;
}
const root = { name: 'ROOT_DESCRIBE_BLOCK' };

test('a test begun that Jest then skips ends as skipped', async () => {
  const e = await env();
  calls.length = 0;
  const t = { name: 'drifts', parent: root, errors: [] };
  await e.handleTestEvent({ name: 'test_start', test: t }, {});
  await e.handleTestEvent({ name: 'test_skip', test: t }, {});
  await e.handleTestEvent({ name: 'test_done', test: t }, {});
  assert.deepEqual(calls, ['begin a.test.js::drifts', 'end a.test.js::drifts skipped']);
  assert.deepEqual(t.errors, []);
});

test('a test Jest starts that was not begun fails, and does not end', async () => {
  const e = await env();
  calls.length = 0;
  const t = { name: 'unbegun', parent: root, mode: 'skip', errors: [] };
  await e.handleTestEvent({ name: 'test_start', test: t }, {});
  await e.handleTestEvent({ name: 'test_started', test: t }, {});
  await e.handleTestEvent({ name: 'test_done', test: t }, {});
  assert.deepEqual(calls, []);
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0].message, /^keploy: Jest runs unbegun, which @keploy\/jest did not begin/);
});

test('the wrapped environment sees every event first, before any call of keploy\'s for it', async () => {
  const e = await env();
  calls.length = 0;
  const t = { name: 'wrapped', parent: root, errors: [] };
  await e.handleTestEvent({ name: 'test_start', test: t }, {});
  await e.handleTestEvent({ name: 'test_done', test: t }, {});
  assert.deepEqual(e.seen, ['test_start 0', 'test_done 1']);
  assert.deepEqual(calls, ['begin a.test.js::wrapped', 'end a.test.js::wrapped passed']);
  // The sandbox's environment names the claimer.
  assert.equal(e.global.process.env.KEPLOY_TEST_PID, String(process.pid));
});
