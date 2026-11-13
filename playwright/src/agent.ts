// The client of keploy's agent: scope protocol v1, the same wire go-sdk's
// keploytest speaks (POST /agent/instance, /agent/scope/begin,
// /agent/scope/end, /agent/scope/given, /agent/refusal).
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
export const PATH_GIVEN = '/agent/scope/given';
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
  variable?: string;
  seed?: string;
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
        `this @keploy/playwright needs a keploy agent that speaks scope protocol v${PROTOCOL_VERSION}: upgrade keploy`, res.status);
    }
    if (v !== PROTOCOL_VERSION) {
      // oxlint-disable-next-line typescript/no-base-to-string -- the version as the agent sent it; its whole answer follows
      throw new KeployError(`keploy: the keploy agent answered ${path} in scope protocol v${String(v)} (${quoted(data)}); ` +
        `this @keploy/playwright speaks scope protocol v${PROTOCOL_VERSION}: use a keploy and a @keploy/playwright of the same release`, res.status);
    }
    return a as Answer;
  }

  /**
   * Sends a call of the scope protocol's first release. keploy speaks it
   * only under its proven switch: with the switch off (keploy's default),
   * the agent has no route for it and answers the mux's plain 404, as a
   * keploy from before the protocol does. So a plain 404 names the switch,
   * saying what it stopped (what).
   */
  private async onWire(path: string, body: unknown, what: string): Promise<Answer> {
    try {
      return await this.post(path, body);
    } catch (err) {
      if (err instanceof KeployError && err.status === 404 && err.code === '') {
        throw new KeployError(`keploy: this keploy agent answered 404 to POST ${path}, so ${what}: ` +
          'keploy speaks @keploy/playwright\'s wire, scope protocol v1, only when it runs with KEPLOY_PROVEN=1 ' +
          '(KEPLOY_PROVEN=1 keploy mock record|replay -c "npx playwright test --workers=1 --retries=0"); ' +
          'a keploy run without KEPLOY_PROVEN=1, or one from before scope protocol v1, answers 404 there', 404);
      }
      throw err;
    }
  }

  /** Claims keploy's run for this test process (a Playwright worker). */
  async claim(key: string, dir: string): Promise<Answer> {
    const a = await this.onWire(PATH_INSTANCE, { key, dir }, 'this worker cannot claim keploy\'s run');
    if (!a.instance) {
      throw new KeployError('keploy: the keploy agent answered the claim of this test process without an instance');
    }
    // a.timeFile names the run's clock when keploy moves it. Node and the
    // browser read the clock through libc, which keploy's preload (inherited
    // from the test command) moves; unlike a Go test binary, which reads it
    // without libc, a Playwright worker needs no launcher to follow it.
    return a;
  }

  /**
   * Asks the agent to open a test. random says how the test's browser means
   * to draw its random numbers, so a finding that the test's calls vary
   * between runs can say whether seeding them is left to try. seed, sent
   * when it means to seed them, is one drawn afresh for this begin; the
   * answer's seed is the one to draw from: in a record the begin's own, in a
   * replay the one the test's recording kept, and none when it kept none. An
   * agent from before either field ignores it and answers no seed.
   */
  async begin(test: TestRef, random?: Random, seed?: string): Promise<Answer> {
    const a = await this.onWire(PATH_BEGIN, { ...test, canSkip: true, ...(random ? { random } : {}), ...(seed ? { seed } : {}) }, `${test.name} cannot begin`);
    if (a.status !== 'ok') {
      throw new KeployError(`keploy: the keploy agent answered the begin of ${test.name} with status ${JSON.stringify(a.status ?? '')}`);
    }
    if (a.action && a.action !== ACTION_SKIP) {
      throw new KeployError(`keploy: the keploy agent answered the begin of ${test.name} with the unknown action ${JSON.stringify(a.action)}`);
    }
    if (a.seed !== undefined && (typeof a.seed !== 'string' || (a.seed !== '' && !SEED.test(a.seed)))) {
      throw new KeployError(`keploy: the keploy agent answered the begin of ${test.name} with the seed ${quoted(typeof a.seed === 'string' ? a.seed : String(JSON.stringify(a.seed)))}, ` +
        'which is no seed keploy keeps (8 to 64 lower-case hex digits)');
    }
    return a;
  }

  /**
   * Tells the agent the test ended, with its outcome, and, when it is known,
   * how its browser drew its random numbers (random), which replaces what its
   * begin meant to do.
   */
  async end(test: TestRef, outcome: Outcome, random?: Random): Promise<Answer> {
    const a = await this.onWire(PATH_END, { ...test, outcome, ...(random ? { random } : {}) }, `${test.name} cannot end`);
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
   * test Playwright retried), so keploy's verdict on the run names it.
   */
  async refuse(code: string, message: string, remedy: string): Promise<void> {
    const a = await this.onWire(PATH_REFUSAL, { code, message, remedy }, 'keploy cannot be told of the refusal');
    if (a.status !== 'ok') {
      throw new KeployError(`keploy: the keploy agent answered the refusal ${code} with status ${JSON.stringify(a.status ?? '')}`);
    }
  }

  /** Gives the open test a value it made itself. Returns the agent's variable name. */
  async given(name: string, value: string, source: string): Promise<string> {
    let a: Answer;
    try {
      a = await this.post(PATH_GIVEN, source ? { name, value, source } : { name, value });
    } catch (err) {
      if (err instanceof KeployError && err.status === 404 && err.code === '') {
        // The route came after the rest of the protocol (keploy v3.6.192):
        // begin, end and settle work on an agent without it. given runs only
        // in a worker whose claim the agent took, so the switch is on and
        // only the version can be missing.
        throw new KeployError(`keploy: this keploy agent answered 404 to POST ${PATH_GIVEN}, so it cannot take the given value ${name}: ` +
          'given needs keploy v3.6.192 or later (keploy/keploy#5016), or an enterprise release on keploy v3.6.192 or later; ' +
          'an older keploy answers 404 there', 404);
      }
      throw err;
    }
    if (a.status !== 'ok' || !a.variable) {
      throw new KeployError(`keploy: the keploy agent answered the given value ${name} with ${JSON.stringify({ status: a.status ?? '', variable: a.variable ?? '' })}`);
    }
    return a.variable;
  }
}

/** A test's name on the wire: keploy builds its ID as [project::]file::name. */
export interface TestRef {
  name: string;
  file: string;
  project?: string;
}

export type Outcome = 'passed' | 'failed' | 'skipped';

/**
 * How a test's browser draws its random numbers: RANDOM_SEEDED from the
 * seed keploy answered its begin with, RANDOM_OWN the browser's own
 * (KEPLOY_SEED_RANDOM=off, the keploySeedRandom option false, or keploy
 * answered no seed). Sent with the begin, it is what the test means to do;
 * with the end, what its pages did.
 */
export type Random = typeof RANDOM_SEEDED | typeof RANDOM_OWN;
export const RANDOM_SEEDED = 'seeded';
export const RANDOM_OWN = 'own';

/** A seed as keploy keeps and answers one: 8 to 64 lower-case hex digits. */
export const SEED = /^[0-9a-f]{8,64}$/;

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
