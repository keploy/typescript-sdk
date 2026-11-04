// The test browser's seeding run in a Node vm context in place of a page:
// a fake Crypto (over Node's own randomness), a location and a session
// storage. Shared by the unit rows and the browser rows, which compare the
// browser's draws with these.
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { pageScript } from '../dist/random.js';

// The draws the rows' pages make at load (test/fixtures/seeded.spec.ts's
// page server sends the same expression).
export const DRAWS = '({ random: [Math.random(), Math.random()], bytes: Array.from(crypto.getRandomValues(new Uint8Array(8))), uuid: crypto.randomUUID() })';
// The same without crypto.randomUUID, for about:blank, which is no secure
// context (test/fixtures/first.spec.ts draws it).
export const BLANK_DRAWS = '({ random: [Math.random(), Math.random()], bytes: Array.from(crypto.getRandomValues(new Uint8Array(8))) })';

/**
 * A document at path whose init script is script. storage is the tab's
 * session storage (a Map), shared by the documents given the same one;
 * null: a document with no session storage (reading it throws). page is the
 * page the fixture named it in (pageScript, run after script as the browser
 * runs a page's init scripts after its context's); null: a document no
 * page script names (a popup with no opener). told collects what the
 * document tells the fixture's function named report: its address, or
 * [address, why] when it says why. origin and href are its location's.
 */
export function documentAt(script, path = '/p', storage = new Map(), page = 't0', { report = '', told = [], origin = 'http://h', href = undefined } = {}) {
  // As the browser's: a this that is no Crypto is refused.
  class Crypto {
    getRandomValues(a) { if (!(this instanceof Crypto)) throw new TypeError('Illegal invocation'); return webcrypto.getRandomValues(a); }
    randomUUID() { if (!(this instanceof Crypto)) throw new TypeError('Illegal invocation'); return webcrypto.randomUUID(); }
  }
  const ctx = { location: { origin, pathname: path, href: href ?? `${origin}${path}` }, Crypto, crypto: new Crypto() };
  if (storage === null) {
    Object.defineProperty(ctx, 'sessionStorage', { get() { throw new Error('SecurityError: no session storage here'); } });
  } else {
    ctx.sessionStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); } };
  }
  if (report) ctx[report] = (at, why) => { told.push(why ? [at, why] : at); return Promise.resolve(); };
  vm.createContext(ctx);
  // A top window: its own parent and top.
  vm.runInContext('globalThis.parent = globalThis; globalThis.top = globalThis;', ctx);
  if (script) vm.runInContext(script, ctx);
  if (page !== null) vm.runInContext(pageScript(page), ctx);
  return { ctx, run: (code) => vm.runInContext(code, ctx), draws: () => JSON.parse(JSON.stringify(vm.runInContext(DRAWS, ctx))) };
}
