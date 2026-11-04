// Settle: before a test's browser context closes, wait until its pages have
// gone quiet and every call they made has ended. The wait begins when the
// context fixture's teardown begins: after the test's body, its afterEach
// hooks and the teardown of any fixture that uses its page or context.
//   - Quiet: QUIET_MS with no call starting or ending and none in flight. A
//     single-page app keeps making calls after the test's last line has
//     returned (a side panel that loads after an answer, a search made after
//     the test typed). Recorded against a slow backend they fall inside the
//     test; replayed, with every answer at once, the test ended before they
//     were made. The browser's request events restart the window, so a call
//     made less than QUIET_MS after an answer, or after the wait began, is
//     the test's at record and at replay alike.
//   - In flight: a call in flight is waited for until it ends, counted by the
//     browser's own request events, so it is answered inside the test
//     instead of being cut by the close (a call keploy recorded whole would
//     be cut at a different byte each run). That time counts toward no bound,
//     so a slow answer at record and a quick one at replay leave the calls
//     that follow an answer to the test at both. Once the pages have had a
//     call in flight for QUIET_MS without a break, the wait for the calls
//     then in flight is a step that names them; a call still in flight after
//     it is named the same way, in a step of its own, so a call that never
//     ends fails the test by its own name.
//   - Bound: QUIET_MAX_MS of time with no call in flight, for pages that never
//     go quiet (a poller), measured with performance.now(): the process's
//     monotonic clock, which no hold on the test's own clock changes.
// Limits (README, Limits of this version):
//   - A call a page's own timer makes while a slow call is in flight at
//     record is the test's there; at replay the window ends before the timer
//     fires and the call is not made.
//   - A poller that waits G ms after each answer of A ms keeps the wait going
//     about QUIET_MAX_MS x (1 + A / G), with a step for each answer of
//     QUIET_MS or more, so against a slow backend its test can time out at
//     record while its replay ends at the bound.

import type { BrowserContext, Frame, Page, Request } from '@playwright/test';

/** The quiet a test's pages keep before it ends: no call started or ended for this long. */
export const QUIET_MS = 500;
/** The most time with no call in flight a test waits for its pages to go quiet. */
export const QUIET_MAX_MS = 3000;

/** What a test says when its pages did not go quiet within QUIET_MAX_MS with no call in flight. */
export function busyLine(name: string): string {
  return `keploy: ${name} ended with its pages still making calls: they did not go ${QUIET_MS} ms without a call starting or ending ` +
    `in ${QUIET_MAX_MS} ms with no call in flight, from the start of its browser context's teardown, so a call they would have made later is ` +
    'not the test\'s, at record or at replay (each call in flight was waited for to its end).';
}

export class Inflight {
  private readonly open = new Map<Request, { frame: Frame | null; nav: boolean }>();
  /** settled()'s waits: each for the calls it was given. */
  private waiters: { calls: Request[]; resolve: () => void }[] = [];
  /** Called on each call that starts or ends, while quiet() waits. */
  private readonly stirs = new Set<() => void>();
  /** The clock quiet() measures its bound with, in milliseconds. */
  private readonly now: () => number;

  constructor(context: BrowserContext, now: () => number = () => performance.now()) {
    this.now = now;
    context.on('request', (r) => {
      let frame: Frame | null = null;
      // A service worker's call has no frame.
      try { frame = r.frame(); } catch { frame = null; }
      this.open.set(r, { frame, nav: r.isNavigationRequest() });
      this.stir();
    });
    context.on('requestfinished', (r) => this.done(r));
    context.on('requestfailed', (r) => this.done(r));
    // The frames whose navigation request was answered with a document, which
    // the frame commits next.
    const loading = new Set<Frame>();
    context.on('response', (res) => {
      const r = res.request();
      if (!r.isNavigationRequest()) return;
      let f: Frame | null = null;
      try { f = r.frame(); } catch { f = null; }
      // A 204 or 205 answer, or a download, leaves the document in place.
      const keeps = res.status() === 204 || res.status() === 205 || /attachment/i.test(res.headers()['content-disposition'] ?? '');
      if (f && !keeps) loading.add(f);
    });
    const watch = (p: Page): void => {
      // The browser reports no end for a call whose document was replaced
      // while it ran: a frame that commits a new document has cancelled
      // every call the old one still had open. The new document's calls
      // start after the commit. A navigation inside the document (the
      // history API, a client-side route change) has no navigation request
      // and replaces nothing.
      p.on('framenavigated', (f) => {
        if (!loading.delete(f)) return;
        this.drop((o) => o.frame === f && !o.nav);
      });
      // Nor for the calls of a page that closes. Only that page's calls: a
      // popup that closes cancels nothing of its opener. (A removed frame's
      // calls the browser does end, as failed requests.)
      p.on('close', () => this.drop((o) => o.frame !== null && pageOf(o.frame) === p));
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    // Nor for any call when the test closes its own context, which ends its
    // service workers too. A service worker's call has no frame, so no
    // page's close drops it; this is the only rule that does.
    context.on('close', () => this.drop(() => true));
  }

  /** The calls in flight now, oldest first. */
  inFlight(): Request[] {
    return [...this.open.keys()];
  }

  get size(): number {
    return this.open.size;
  }

  /**
   * Resolves true once the context's pages have gone quietMs with no call
   * starting or ending and none in flight; false once maxMs with no call in
   * flight have passed first. Each call that starts or ends restarts the
   * window. A call in flight is waited for until it ends, and that time
   * counts toward neither; once the pages have had a call in flight for
   * quietMs without a break, the wait is named(), which resolves once the
   * calls then in flight have ended (settled(), in a step that names them).
   * A call still in flight after it is named in a wait of its own.
   */
  async quiet(quietMs: number, maxMs: number, named: () => Promise<void>): Promise<boolean> {
    let left = maxMs;
    for (;;) {
      if (this.open.size === 0) {
        const from = this.now();
        const ended = await this.idle(quietMs, left);
        if (ended !== 'busy') return ended === 'quiet';
        left -= this.now() - from;
      } else if (await this.busy(quietMs)) {
        await named();
      }
    }
  }

  /**
   * While no call is in flight: 'quiet' once quietMs pass with no call
   * starting or ending, 'bound' once maxMs pass, 'busy' once a call starts.
   */
  private idle(quietMs: number, maxMs: number): Promise<'quiet' | 'bound' | 'busy'> {
    return new Promise((resolve) => {
      let window = setTimeout(() => end('quiet'), quietMs);
      const bound = setTimeout(() => end('bound'), maxMs);
      const stir = (): void => {
        if (this.open.size > 0) { end('busy'); return; }
        clearTimeout(window);
        window = setTimeout(() => end('quiet'), quietMs);
      };
      const end = (ended: 'quiet' | 'bound' | 'busy'): void => {
        clearTimeout(window);
        clearTimeout(bound);
        this.stirs.delete(stir);
        resolve(ended);
      };
      this.stirs.add(stir);
    });
  }

  /**
   * While a call is in flight: false once none is, true once the calls have
   * been in flight for quietMs without a break.
   */
  private busy(quietMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const long = setTimeout(() => end(true), quietMs);
      const stir = (): void => { if (this.open.size === 0) end(false); };
      const end = (lasted: boolean): void => {
        clearTimeout(long);
        this.stirs.delete(stir);
        resolve(lasted);
      };
      this.stirs.add(stir);
    });
  }

  /**
   * Resolves once none of calls (by default, the calls in flight now) is in
   * flight. A call that starts later is not waited for here.
   */
  settled(calls: Request[] = this.inFlight()): Promise<void> {
    if (!calls.some((r) => this.open.has(r))) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ calls, resolve }));
  }

  private done(r: Request): void {
    if (this.open.delete(r)) this.wake();
    this.stir();
  }

  private drop(gone: (o: { frame: Frame | null; nav: boolean }) => boolean): void {
    let n = 0;
    for (const [r, o] of this.open) {
      if (gone(o)) { this.open.delete(r); n++; }
    }
    if (n > 0) { this.wake(); this.stir(); }
  }

  /** A call started or ended: tells quiet()'s wait. */
  private stir(): void {
    this.stirs.forEach((f) => f());
  }

  /** A call left: resolves each wait none of whose calls is in flight. */
  private wake(): void {
    const done = this.waiters.filter((w) => !w.calls.some((r) => this.open.has(r)));
    this.waiters = this.waiters.filter((w) => !done.includes(w));
    done.forEach((w) => w.resolve());
  }
}

function pageOf(f: Frame): Page | null {
  try { return f.page(); } catch { return null; }
}
