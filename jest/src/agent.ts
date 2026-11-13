// The client of keploy's agent: scope protocol v1, the same wire go-sdk's
// keploytest and @keploy/playwright speak (POST /agent/instance,
// /agent/scope/begin, /agent/scope/end, /agent/refusal).
//
// Every answer of the agent carries the protocol version as "v"; an answer
// without it, or with another version, is an error, so this package on an
// old agent (or the reverse) fails loudly instead of running unjudged. Every
// way an answer can fail to be trusted is an error. Nothing is retried, and
// no clock decides anything: the agent answers once the work it owes is done.

export const PROTOCOL_VERSION = 1;

export const PATH_INSTANCE = '/agent/instance';
export const PATH_BEGIN = '/agent/scope/begin';
export const PATH_END = '/agent/scope/end';
export const PATH_REFUSAL = '/agent/refusal';

export const ACTION_SKIP = 'skip';
export const ACTION_FAIL = 'fail';

// Bounds what is read of one answer, and how much of one an error quotes.
const MAX_ANSWER = 1 << 20;
const MAX_QUOTED = 512;

/** A 2xx answer of the agent. */
export interface Answer {
  v: number;
  status?: string;
  action?: string;
  reason?: string;
  instance?: string;
  timeFile?: string;
}

/** An answer this package cannot trust, or the agent's own refusal. */
export class KeployError extends Error {
  /** The HTTP status of a non-2xx answer; 0 when there was none. */
  readonly status: number;
  /** The scope protocol's error code of a refusal ("not_open", ...). */
  readonly code: string;
  constructor(message: string, status = 0, code = '') {
    super(message);
    this.name = 'KeployError';
    this.status = status;
    this.code = code;
  }
}

export function quoted(text: string): string {
  const s = text.trim();
  return s.length > MAX_QUOTED ? `${JSON.stringify(s.slice(0, MAX_QUOTED))}...` : JSON.stringify(s);
}

/** Talks to one keploy agent. */
export class AgentClient {
  constructor(readonly url: string, readonly token: string) {}

  /** Sends one call and reads its answer. */
  async post(path: string, body: unknown): Promise<Answer> {
    const target = this.url.replace(/\/+$/, '') + path;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      // A redirect is an answer like any other non-2xx: following it would
      // send the call again, or to somewhere else.
      res = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' });
    } catch (err) {
      throw new KeployError(`keploy: cannot reach the keploy agent at ${this.url}: ${causeOf(err)}`);
    }
    let data: string;
    try {
      data = await readBounded(res);
    } catch (err) {
      throw new KeployError(`keploy: cannot read the keploy agent's answer to ${path}: ${causeOf(err)}`, res.status);
    }
    if (res.status < 200 || res.status > 299) {
      let e: { error?: unknown; message?: unknown; remedy?: unknown } = {};
      try { e = JSON.parse(data); } catch { /* not the protocol's error body */ }
      if (e && typeof e.message === 'string' && e.message !== '') {
        const code = typeof e.error === 'string' ? e.error : '';
        const remedy = typeof e.remedy === 'string' && e.remedy !== '' ? ` (${e.remedy})` : '';
        throw new KeployError(`keploy: ${e.message}${remedy}`, res.status, code);
      }
      throw new KeployError(`keploy: the keploy agent answered ${res.status} ${res.statusText} to ${path}: ${quoted(data)}`, res.status);
    }
    let a: unknown;
    try {
      a = JSON.parse(data);
    } catch (err) {
      throw new KeployError(`keploy: the keploy agent's answer to ${path} cannot be read (${causeOf(err)}): ${quoted(data)}`, res.status);
    }
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      throw new KeployError(`keploy: the keploy agent's answer to ${path} cannot be read (not an object): ${quoted(data)}`, res.status);
    }
    const v = (a as { v?: unknown }).v;
    if (v === undefined || v === null) {
      throw new KeployError(`keploy: the keploy agent answered ${path} with ${quoted(data)}, which names no scope protocol version; ` +
        `this @keploy/jest needs a keploy agent that speaks scope protocol v${PROTOCOL_VERSION}: upgrade keploy`, res.status);
    }
    if (v !== PROTOCOL_VERSION) {
      throw new KeployError(`keploy: the keploy agent answered ${path} in scope protocol v${String(v)} (${quoted(data)}); ` +
        `this @keploy/jest speaks scope protocol v${PROTOCOL_VERSION}: use a keploy and a @keploy/jest of the same release`, res.status);
    }
    return a as Answer;
  }

  /**
   * Sends one call of scope protocol v1. keploy speaks the protocol only
   * under its proven switch: with it off (keploy's default) the agent has
   * none of the protocol's routes and answers the mux's plain 404, as a
   * keploy from before the protocol does. Any call can be the first to meet
   * that 404 (a claim answered before keploy restarted without the switch),
   * so each names the switch; keploy's own 404 (a refusal with a code) is
   * keploy's reason and passes as it is.
   */
  private async onWire(path: string, body: unknown, what: string): Promise<Answer> {
    try {
      return await this.post(path, body);
    } catch (err) {
      if (err instanceof KeployError && err.status === 404 && err.code === '') {
        throw new KeployError(`keploy: this keploy agent answered 404 to POST ${path}, so ${what}: ` +
          'keploy speaks @keploy/jest\'s wire, scope protocol v1, only when it runs with KEPLOY_PROVEN=1 ' +
          '(KEPLOY_PROVEN=1 keploy mock record|replay -c "npx jest -i"); ' +
          'a keploy run without KEPLOY_PROVEN=1, or one from before scope protocol v1, answers 404 there', 404);
      }
      throw err;
    }
  }

  /** Claims keploy's run for this test process (a Jest worker, or Jest itself with -i). */
  async claim(key: string, dir: string): Promise<Answer> {
    const a = await this.onWire(PATH_INSTANCE, { key, dir }, 'this Jest process cannot claim keploy\'s run');
    if (!a.instance) {
      throw new KeployError('keploy: the keploy agent answered the claim of this test process without an instance');
    }
    // a.timeFile names the run's clock when keploy moves it. Node reads the
    // clock through libc, which keploy's preload (inherited from the test
    // command) moves; unlike a Go test binary, which reads it without libc,
    // a Jest process needs no launcher to follow it.
    return a;
  }

  /** Asks the agent to open a test. */
  async begin(test: TestRef): Promise<Answer> {
    const a = await this.onWire(PATH_BEGIN, { ...test, canSkip: true }, `${test.name} cannot begin`);
    if (a.status !== 'ok') {
      throw new KeployError(`keploy: the keploy agent answered the begin of ${test.name} with status ${JSON.stringify(a.status ?? '')}`);
    }
    if (a.action && a.action !== ACTION_SKIP) {
      throw new KeployError(`keploy: the keploy agent answered the begin of ${test.name} with the unknown action ${JSON.stringify(a.action)}`);
    }
    return a;
  }

  /** Tells the agent the test ended, with its outcome. */
  async end(test: TestRef, outcome: Outcome): Promise<Answer> {
    const a = await this.onWire(PATH_END, { ...test, outcome }, `${test.name} cannot end`);
    if (a.status !== 'ok') {
      throw new KeployError(`keploy: the keploy agent answered the end of ${test.name} with status ${JSON.stringify(a.status ?? '')}`);
    }
    if (a.action && a.action !== ACTION_FAIL) {
      throw new KeployError(`keploy: the keploy agent answered the end of ${test.name} with the unknown action ${JSON.stringify(a.action)}`);
    }
    return a;
  }

  /**
   * Tells keploy this package refused something keploy cannot judge (a
   * test Jest would run at once with another, or run a second time), so
   * keploy's verdict on the run names it.
   */
  async refuse(code: string, message: string, remedy: string): Promise<void> {
    const a = await this.onWire(PATH_REFUSAL, { code, message, remedy }, 'keploy cannot be told of the refusal');
    if (a.status !== 'ok') {
      throw new KeployError(`keploy: the keploy agent answered the refusal ${code} with status ${JSON.stringify(a.status ?? '')}`);
    }
  }
}

/** A test's name on the wire: keploy builds its ID as [project::]file::name. */
export interface TestRef {
  name: string;
  file: string;
  project?: string;
}

export type Outcome = 'passed' | 'failed' | 'skipped';

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER) {
      await reader.cancel();
      throw new Error(`the answer is larger than ${MAX_ANSWER} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function causeOf(err: unknown): string {
  if (err instanceof Error) {
    const c = (err as Error & { cause?: unknown }).cause;
    return c instanceof Error ? `${err.message}: ${c.message}` : err.message;
  }
  return String(err);
}
