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
 * [address, why] when it says why ([address, why, others] for 'uncounted').
 * origin and href are its location's.
 * parent is the window's parent: the window itself (a top window) when
 * undefined; null for a removed frame; OTHER for a parent of another origin
 * (reading it throws); or an object, a parent of the frame's origin. frames:
 * how many frames a parent of another origin says it holds (its length,
 * which another origin may read); undefined: reading it throws too. element
 * is the window's frameElement, read through a getter. doc is its document
 * (with URL beside it), for a document whose frames the row makes. opener
 * is the window's opener (none when undefined).
 */
export const OTHER = Symbol('a parent of another origin');
export function documentAt(script, path = '/p', storage = new Map(), page = 't0', { report = '', told = [], origin = 'http://h', href = undefined, parent = undefined, doc = undefined, frames = undefined, element = undefined, opener = undefined } = {}) {
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
  if (report) ctx[report] = (at, why, others) => { told.push(why === 'uncounted' ? [at, why, others] : why ? [at, why] : at); return Promise.resolve(); };
  if (element !== undefined) Object.defineProperty(ctx, 'frameElement', { get() { return element; }, configurable: true, enumerable: true });
  if (doc !== undefined) { ctx.document = doc; ctx.URL = URL; }
  if (opener !== undefined) ctx.opener = opener;
  vm.createContext(ctx);
  // A top window: its own parent and top.
  vm.runInContext('globalThis.parent = globalThis; globalThis.top = globalThis;', ctx);
  if (parent !== undefined) {
    ctx.parent = parent === OTHER ? new Proxy({}, {
      get(t, k) {
        if (k === 'length' && frames !== undefined) return frames;
        throw new Error('SecurityError: a parent of another origin');
      },
    }) : parent;
  }
  if (script) vm.runInContext(script, ctx);
  if (page !== null) vm.runInContext(pageScript(page), ctx);
  return { ctx, run: (code) => vm.runInContext(code, ctx), draws: () => JSON.parse(JSON.stringify(vm.runInContext(DRAWS, ctx))) };
}
