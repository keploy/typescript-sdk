const { spawnSync } = require('node:child_process');
const log = require('./../log.cjs');
test('spawns', () => {
  // The sandbox's process.env, as a test passes it to a process it starts.
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.KEPLOY_TEST_PID || "")'], { env: { ...process.env } });
  log(`child marker ${r.stdout.toString()}`);
  // No env given: Node starts the process with its own process.env, which
  // is not the sandbox's.
  const d = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.KEPLOY_TEST_PID || "")']);
  log(`default child marker ${d.stdout.toString()}`);
});
