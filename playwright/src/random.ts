// Seeded randomness for the test browser. A page that draws random numbers
// (stripe.js picks one of two builds from crypto.randomUUID() at each page
// load) makes other calls each run, and no recording can answer a call it
// never saw. So under keploy each test's browser draws from a seeded stream
// instead. Each test's begin sends a seed drawn afresh, and keploy answers
// the seed to draw from: a record keeps the begin's with the test's
// recording, and a replay answers the recording's. So record and replay
// draw the same numbers and pick the same side, two tests draw different
// ones, and a record made again draws new ones (a browser-made ID is not sent
// twice to a real server). Only the test browser's pages change; the app,
// its server and the browser's workers do not.
//
// On by default; KEPLOY_SEED_RANDOM=off or the fixture option
// keploySeedRandom: false turns it off.

import crypto from 'node:crypto';

export const ENV_SEED_RANDOM = 'KEPLOY_SEED_RANDOM';

/** The option that turns seeding off for a project, a file or a test. */
export const OPTION_SEED_RANDOM = 'keploySeedRandom';

export type Seeding = { mode: 'seeded' } | { mode: 'off' } | { mode: 'refused'; refusal: string };

/** Whether the environment leaves seeding on (unset, on) or turns it off. */
export function seedingFromEnv(env: NodeJS.ProcessEnv): Seeding {
  const v = (env[ENV_SEED_RANDOM] ?? '').trim();
  const l = v.toLowerCase();
  if (l === '' || l === 'on' || l === '1' || l === 'true') return { mode: 'seeded' };
  if (l === 'off' || l === '0' || l === 'false') return { mode: 'off' };
  return {
    mode: 'refused',
    refusal: `keploy: ${ENV_SEED_RANDOM}=${JSON.stringify(v)} is neither on nor off; set it to off to give the test browser its own random numbers, ` +
      'or unset it to seed them per test',
  };
}

/** The line a worker shows once, at the first test whose browser it seeds. */
export const SEEDED_LINE = 'keploy: the test browser\'s random numbers (Math.random, crypto.getRandomValues, crypto.randomUUID) are seeded per test ' +
  'from a seed keploy keeps with the test\'s recording, so a replay draws the numbers its recording drew; ' +
  'Web Workers and Service Workers keep the browser\'s own. ' +
  `To turn it off, record and replay with ${ENV_SEED_RANDOM}=off, or set use: { ${OPTION_SEED_RANDOM}: false } in the Playwright config.`;

/**
 * The line a test shows when it asked keploy for a seed and got none, so its
 * pages draw the browser's own random numbers.
 */
export function unseededLine(name: string): string {
  return `keploy: keploy answered the begin of ${name} with no seed, so its browser draws its own random numbers: ` +
    'its recording kept none (it was recorded before keploy kept seeds, or with seeding off), or this keploy predates seeds. ' +
    'Record the test again with seeding on (the default) to seed it.';
}

/** A seed drawn afresh for a test's begin: 128 bits, as hex. */
export function freshSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}

// A key of the page's session storage: how many documents of each path the
// tab has loaded from the document's origin, so that a document loaded again
// in the same test (a reload, a second visit) draws new numbers, as it would
// unseeded, and still the same ones each run.
export const LOADS_KEY = '__keploy_random_loads';

/**
 * The init script that seeds a document: one stream for each of
 * Math.random, crypto.getRandomValues and crypto.randomUUID, from the seed,
 * the document's path and how many documents of that path its origin loaded
 * in the tab before. The path alone names the document: a replay may serve
 * the app at another host or port than its record did, and a query often
 * carries a time. So two frames of different origins at the same path draw
 * the same numbers. A stream for each function keeps one's draws from
 * shifting another's: a timer's Math.random does not move the next
 * crypto.randomUUID.
 */
export function initScript(seed: string): string {
  return `(() => {
  const seed = ${JSON.stringify(seed)};
  const imul = Math.imul;
  // cyrb128: a string's 128-bit hash, a stream's four words.
  const hash = (s) => {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < s.length; i++) {
      const k = s.charCodeAt(i);
      h1 = h2 ^ imul(h1 ^ k, 597399067);
      h2 = h3 ^ imul(h2 ^ k, 2869860233);
      h3 = h4 ^ imul(h3 ^ k, 951274213);
      h4 = h1 ^ imul(h4 ^ k, 2716044179);
    }
    h1 = imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  };
  // sfc32 over those words: 32 random bits a call.
  const stream = (s) => {
    let [a, b, c, d] = hash(s);
    const next = () => {
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return t >>> 0;
    };
    for (let i = 0; i < 15; i++) next();
    return next;
  };
  let place = '';
  try { place = location.pathname; } catch (e) { place = ''; }
  let loads = 0;
  try {
    const store = sessionStorage;
    let seen = {};
    try { seen = JSON.parse(store.getItem(${JSON.stringify(LOADS_KEY)}) || '{}') || {}; } catch (e) { seen = {}; }
    if (typeof seen !== 'object' || Array.isArray(seen)) seen = {};
    loads = typeof seen[place] === 'number' ? seen[place] : 0;
    seen[place] = loads + 1;
    store.setItem(${JSON.stringify(LOADS_KEY)}, JSON.stringify(seen));
  } catch (e) {
    // No session storage here (a sandboxed frame, an opaque origin): every
    // document of this address draws the same numbers.
  }
  const key = seed + '\\n' + place + '\\n' + loads + '\\n';
  const define = (o, name, value) => {
    const d = Object.getOwnPropertyDescriptor(o, name);
    Object.defineProperty(o, name, { value, writable: d ? d.writable : true, enumerable: d ? d.enumerable : false, configurable: true });
  };
  const fill = (next, u) => {
    for (let i = 0; i < u.length; i += 4) {
      let w = next();
      for (let j = 0; j < 4 && i + j < u.length; j++) { u[i + j] = w & 255; w >>>= 8; }
    }
  };
  const rnd = stream(key + 'Math.random');
  // 53 bits, as the browser's own Math.random gives.
  define(Math, 'random', { random() { return ((rnd() >>> 5) * 67108864 + (rnd() >>> 6)) / 9007199254740992; } }.random);
  const C = typeof Crypto === 'function' ? Crypto.prototype : null;
  if (C && typeof C.getRandomValues === 'function') {
    const real = C.getRandomValues;
    const grv = stream(key + 'crypto.getRandomValues');
    define(C, 'getRandomValues', { getRandomValues(array) {
      // The browser's own call first: it refuses what the browser refuses
      // (a float array, more than 65536 bytes, a this that is no Crypto).
      const out = real.call(this, array);
      fill(grv, new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
      return out;
    } }.getRandomValues);
  }
  if (C && typeof C.randomUUID === 'function') {
    const realUUID = C.randomUUID;
    const uuid = stream(key + 'crypto.randomUUID');
    define(C, 'randomUUID', { randomUUID() {
      realUUID.call(this);
      const b = new Uint8Array(16);
      fill(uuid, b);
      b[6] = (b[6] & 15) | 64;
      b[8] = (b[8] & 63) | 128;
      let h = '';
      for (let i = 0; i < 16; i++) {
        h += (b[i] + 256).toString(16).slice(1);
        if (i === 3 || i === 5 || i === 7 || i === 9) h += '-';
      }
      return h;
    } }.randomUUID);
  }
})();
`;
}
