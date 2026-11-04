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
//     the test's at record and at replay alike. The window is this process's
//     timer, and a loaded machine can hold this process's event loop while
//     the browser's events wait unread, so a window that has passed ends the
//     wait only once the browser has answered a call made then
//     (context.cookies(), answered by the browser, not by a page's script):
//     a call it reported before that answer keeps the wait going.
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
//   - Cap: QUIET_CAP_MS of wall time from the start of the wait, on the same
//     clock, the same at record and at replay, for pages whose calls overlap
//     so that the bound never accrues. A call is in flight until the browser
//     reports its end, and for an answer the page never reads Chromium
//     reports it about 50 ms after the answer, so a page that calls every
//     50 ms without reading the answers always has a call in flight. Once
//     the cap has passed, the calls in flight then are waited for to their
//     end, by name once they have lasted QUIET_MS, so a call that never ends
//     still fails the test by its own name. A call that starts after the cap
//     is not waited for: it falls inside the test only if it reaches the
//     backend before the calls in flight at the cut end, and closing the
//     context cancels it if it is still in flight then.
// Limits (README, Limits of this version):
//   - A call a page's own timer makes while a slow call is in flight at
//     record is the test's there; at replay the window ends before the timer
//     fires and the call is not made.
//   - A poller that waits G ms after each answer of A ms keeps the wait going
//     about QUIET_MAX_MS x (1 + A / G), with a step for each answer of
//     QUIET_MS or more, until the cap cuts it: against a slow backend its
//     record ends at the cap, and the calls it would have made after it, made
//     at replay, where the wait ends at the bound, are not in the recording.
//   - The cap counts the time a call is in flight: a page whose calls keep
//     it from going quiet for QUIET_CAP_MS at record, and not at replay (a
//     slow backend), leaves different calls to its test at the two.
//   - The wait knows only the calls the browser has reported: a page whose
//     scripts do not run for QUIET_MS with no call in flight has gone quiet,
//     even when only a starved machine held them, and a call it makes after
//     that is not the test's.

import type { BrowserContext, Frame, Page, Request } from '@playwright/test';

/** The quiet a test's pages keep before it ends: no call started or ended for this long. */
export const QUIET_MS = 500;
/** The most time with no call in flight a test waits for its pages to go quiet. */
export const QUIET_MAX_MS = 3000;
/** The most wall time, from the start of the wait, a test waits for its pages to go quiet. */
export const QUIET_CAP_MS = 5000;

/** What a test says when its pages did not go quiet within QUIET_MAX_MS with no call in flight. */
export function busyLine(name: string): string {
  return `keploy: ${name} ended with its pages still making calls: they did not go ${QUIET_MS} ms without a call starting or ending ` +
    `in ${QUIET_MAX_MS} ms with no call in flight, from the start of its browser context's teardown, so a call they would have made later is ` +
    'not the test\'s, at record or at replay (each call in flight was waited for to its end).';
}

/** What a test says when QUIET_CAP_MS cut its wait before its pages went quiet or reached QUIET_MAX_MS. */
export function cutLine(name: string): string {
  return `keploy: ${name}: settle cut at ${QUIET_CAP_MS / 1000} s: calls never went quiet for ${QUIET_MS} ms; the page's calls kept it busy ` +
    'from the start of its browser context\'s teardown. Each call in flight at the cut was waited for to its end; a call a page starts ' +
    'later is not waited for, at record or at replay.';
}

/** The step title of a wait on calls in flight: it names them, five at most. */
export function waitTitle(calls: Request[]): string {
  const names = calls.map((r) => `${r.method()} ${r.url()}`);
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '');
  return `keploy: wait for the test's ${calls.length} call(s) in flight before its browser context closes: ${shown}`;
}

/**
 * quiet()'s named(): a wait on calls in flight that has lasted, run as
 * step(title, body). It names the calls it is given, by default the calls in
 * flight when it is made, and waits for those: a call that starts before
 * step() runs its body (Playwright's step can wait on the browser first) is
 * left to a wait of its own.
 */
export function namedWait(inflight: Inflight, step: (title: string, body: () => Promise<void>) => Promise<void>): (calls?: Request[]) => Promise<void> {
  return (calls = inflight.inFlight()) => step(waitTitle(calls), () => inflight.settled(calls));
}

export class Inflight {
  private readonly open = new Map<Request, { frame: Frame | null; nav: boolean }>();
  /** settled()'s waits: each for the calls it was given. */
  private waiters: { calls: Request[]; resolve: () => void }[] = [];
  /** Called on each call that starts or ends, while quiet() waits. */
  private readonly stirs = new Set<() => void>();
  /** The clock quiet() measures its bound with, in milliseconds. */
  private readonly now: () => number;
  /** A call to the browser that it answers after the events it sent before. */
  private readonly ask: () => Promise<unknown>;

  /**
   * ask: a call the browser answers on its own, not its pages' scripts, by
   * default context.cookies(). Its answer comes after every event the browser
   * sent before it, so the calls a page made while this process's event loop
   * was held are known before a wait that has ended is believed.
   */
  constructor(context: BrowserContext, now: () => number = () => performance.now(), ask: () => Promise<unknown> = () => context.cookies()) {
    this.now = now;
    this.ask = ask;
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
   * Resolves 'quiet' once the context's pages have gone quietMs with no call
   * starting or ending and none in flight; 'bound' once maxMs with no call in
   * flight have passed first; 'cut' once capMs of wall time from its start
   * have passed first and the calls in flight then have ended. Each call that
   * starts or ends restarts the window. A call in flight is waited for until
   * it ends, and that time counts toward the cap only; once the pages have
   * had a call in flight for quietMs without a break, the wait is named(),
   * which resolves once the calls then in flight have ended (settled(), in a
   * step that names them). A call still in flight after it is named in a wait
   * of its own. Once the cap has passed, only the calls in flight then are
   * waited for, by name once they have been in flight for quietMs: a call
   * that starts after it is not.
   */
  async quiet(quietMs: number, maxMs: number, capMs: number, named: (calls?: Request[]) => Promise<void>): Promise<'quiet' | 'bound' | 'cut'> {
    const until = this.now() + capMs;
    let left = maxMs;
    for (;;) {
      if (this.open.size === 0) {
        const from = this.now();
        const ended = await this.idle(quietMs, left, until - from);
        if (ended !== 'busy') return ended;
        left -= this.now() - from;
        continue;
      }
      let ended = await this.busy(quietMs, until - this.now());
      if (ended === 'idle') continue;
      if (ended === 'long') {
        const cut = await this.during(named, until);
        if (cut === null) continue;
        ended = await this.busy(quietMs, 0, cut);
      }
      // The cap has passed: these are the calls in flight then that are still
      // in flight after quietMs, if any.
      if (ended.length > 0) await named(ended);
      return 'cut';
    }
  }

  /** named(), and the calls in flight when the cap (at until) passed while it ran, or null. */
  private async during(named: () => Promise<void>, until: number): Promise<Request[] | null> {
    const passed: { calls: Request[] | null } = { calls: null };
    const cap = setTimeout(() => { passed.calls = this.inFlight(); }, Math.max(0, until - this.now()));
    try { await named(); } finally { clearTimeout(cap); }
    return passed.calls;
  }

  /**
   * While no call is in flight: 'quiet' once quietMs pass with no call
   * starting or ending, 'bound' once maxMs pass, 'cut' once capMs pass,
   * 'busy' once a call starts. A timer that fires says only that this
   * process saw no call for that long: while its event loop was held (a
   * loaded machine), the browser's events wait unread, and a timer runs
   * before them. So the wait asks the browser first (ask()) and ends only
   * once it has answered: a call started before the answer makes it 'busy',
   * and a call that ended before it, for 'quiet', restarts the window.
   */
  private idle(quietMs: number, maxMs: number, capMs: number): Promise<'quiet' | 'bound' | 'cut' | 'busy'> {
    return new Promise((resolve) => {
      let stirred = 0;
      const ask = (verdict: 'quiet' | 'bound' | 'cut'): void => {
        const seen = stirred;
        // Once the wait has ended, end() again changes nothing.
        const then = (): void => {
          if (verdict === 'quiet' && stirred !== seen) return;
          end(verdict);
        };
        // A browser that cannot answer (its context is closing) leaves the
        // verdict as it stands.
        Promise.resolve().then(this.ask).then(then, then);
      };
      let window = setTimeout(() => ask('quiet'), quietMs);
      // The bound can have passed already: a call the browser reported
      // before its answer was then waited for. Node warns, in the test's own
      // output, of a timer set for a negative time.
      const bound = setTimeout(() => ask('bound'), Math.max(0, maxMs));
      const cap = setTimeout(() => ask('cut'), Math.max(0, capMs));
      const stir = (): void => {
        stirred++;
        if (this.open.size > 0) { end('busy'); return; }
        clearTimeout(window);
        window = setTimeout(() => ask('quiet'), quietMs);
      };
      const end = (verdict: 'quiet' | 'bound' | 'cut' | 'busy'): void => {
        clearTimeout(window);
        clearTimeout(bound);
        clearTimeout(cap);
        this.stirs.delete(stir);
        resolve(verdict);
      };
      this.stirs.add(stir);
    });
  }

  /**
   * While a call is in flight: 'idle' once none is, 'long' once the calls
   * have been in flight for quietMs without a break. Once capMs have passed
   * (or from the start, given cut: the calls in flight when it passed), only
   * the calls in flight then count: [] once they have ended, or those still
   * in flight once quietMs have passed.
   */
  private busy(quietMs: number, capMs: number): Promise<'idle' | 'long' | Request[]>;
  private busy(quietMs: number, capMs: number, cut: Request[]): Promise<Request[]>;
  private busy(quietMs: number, capMs: number, cut: Request[] | null = null): Promise<'idle' | 'long' | Request[]> {
    return new Promise((resolve) => {
      const at: { cut: Request[] | null } = { cut };
      const left = (calls: Request[]): Request[] => calls.filter((r) => this.open.has(r));
      const long = setTimeout(() => end(at.cut === null ? 'long' : left(at.cut)), quietMs);
      const stir = (): void => {
        if (at.cut === null) { if (this.open.size === 0) end('idle'); } else if (left(at.cut).length === 0) end([]);
      };
      const cap = at.cut === null ? setTimeout(() => { at.cut = this.inFlight(); stir(); }, Math.max(0, capMs)) : undefined;
      const end = (ended: 'idle' | 'long' | Request[]): void => {
        clearTimeout(long);
        clearTimeout(cap);
        this.stirs.delete(stir);
        resolve(ended);
      };
      this.stirs.add(stir);
      // Given calls that have all ended already, the wait for them ends now.
      stir();
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
