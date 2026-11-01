// Whether this process reports to keploy: the same rule go-sdk's keploytest
// follows. keploy mock record and keploy mock replay export
// KEPLOY_MOCK_AGENT (the agent's URL), KEPLOY_MOCK_AGENT_TOKEN and
// KEPLOY_MOCK_PROJECT (the project's directory) into the test command.
// Unset or "off", the package is inert and every test runs as it would
// without keploy.

import fs from 'node:fs';

export const ENV_AGENT = 'KEPLOY_MOCK_AGENT';
export const ENV_TOKEN = 'KEPLOY_MOCK_AGENT_TOKEN';
export const ENV_PROJECT = 'KEPLOY_MOCK_PROJECT';
// The claimer's pid, exported once a test process has claimed the run, so
// the processes its tests start (the browser, a helper) know they belong to
// it and do not claim the run themselves.
export const ENV_TEST_PID = 'KEPLOY_TEST_PID';

export type Joining =
  | { mode: 'inert' }
  | { mode: 'refused'; refusal: string }
  | { mode: 'active'; url: string; token: string; project: string };

export function decide(env: NodeJS.ProcessEnv, pid: number, runsInside: (pid: number) => boolean = runsInsideProc): Joining {
  const v = (env[ENV_AGENT] ?? '').trim();
  if (v === '' || v.toLowerCase() === 'off') return { mode: 'inert' };
  let u: URL | null = null;
  try { u = new URL(v); } catch { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.host === '') {
    return {
      mode: 'refused',
      refusal: `keploy: ${ENV_AGENT}=${JSON.stringify(v)} is neither off nor the http URL of a keploy agent; set it to off to run without keploy`,
    };
  }
  const tp = (env[ENV_TEST_PID] ?? '').trim();
  if (tp !== '' && tp !== String(pid)) {
    // Another process joined keploy's run. This one is a member only when
    // it runs inside that process; a marker naming any other process was
    // inherited from elsewhere, and this process claims like any test
    // process (the agent refuses a second live one).
    const n = Number(tp);
    if (Number.isInteger(n) && n > 0 && runsInside(n)) return { mode: 'inert' };
  }
  return { mode: 'active', url: v.replace(/\/+$/, ''), token: env[ENV_TOKEN] ?? '', project: (env[ENV_PROJECT] ?? '').trim() };
}

// Whether this process runs inside process pid (pid is an ancestor), read
// from /proc. Without /proc (a system other than Linux) it cannot tell, and
// takes the marker at its word.
export function runsInsideProc(pid: number): boolean {
  if (!fs.existsSync('/proc/self/stat')) return true;
  let p = process.ppid;
  for (let i = 0; i < 128 && p > 0; i++) {
    if (p === pid) return true;
    const next = procParent(p);
    if (next === null || next === p) return false;
    p = next;
  }
  return false;
}

function procParent(pid: number): number | null {
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  // The command name, in parentheses, may hold spaces and parentheses: the
  // fields after it start at the last ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : null;
}
