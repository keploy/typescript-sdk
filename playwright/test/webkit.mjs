// WebKit's own defects that the browser rows meet, with keploy or without.

/**
 * Whether WebKit dropped served.spec.ts's redirected Shared Worker. WebKit
 * (27.2, under Playwright 1.65) sometimes never runs a Shared Worker whose
 * script the server redirects: it asks for /rds/s.js, follows the 302 to
 * /rds/v2/s.js, gets that script, and then does nothing more, with no
 * request for the h.js the script imports first, no error event and no
 * message. The same happens with plain Playwright and no keploy, on a busy
 * machine. The rows accept a missing answer only on exactly that record:
 * engine is WebKit, got (what the fixture kept for the worker) is 'none'
 * (neither a message nor an error event came), and the server (seen: every
 * URL it was asked for in the run) served /rds/s.js and /rds/v2/s.js once
 * each and never /rds/v2/h.js. Anything else is no drop: the rows assert
 * it as they would.
 */
export function webkitDroppedSharedWorker(engine, got, seen) {
  if (engine !== 'webkit' || got !== 'none') return false;
  const asked = (p) => seen.filter((u) => u === p).length;
  return asked('/rds/s.js') === 1 && asked('/rds/v2/s.js') === 1 && asked('/rds/v2/h.js') === 0;
}

/** The line a row prints for each run where it accepted that drop. */
export const webkitDroppedLine = (run) => `WebKit dropped the redirected Shared Worker /rds/s.js in the ${run} run: the server served /rds/s.js and /rds/v2/s.js once each, nothing asked for /rds/v2/h.js, and no message or error event came; WebKit's own defect (the same with no keploy), accepted on exactly this record`;
