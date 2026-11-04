// Unit rows of the test browser's seeding: the env rule, the seed, and the
// init script run in a Node vm context in place of a page. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_KEY, ENV_SEED_RANDOM, LOADS_KEY, PAGE_KEY, SEEDED_LINE, freshSeed, initScript, pageAddress, pageScript, placePages, seedingFromEnv, unplacedLine, unseededLine } from '../dist/random.js';
import { SEED } from '../dist/agent.js';
import { OTHER, documentAt } from './draws.mjs';

// Two seeds, as keploy answers them.
const S1 = '0123456789abcdef0123456789abcdef';
const S2 = 'fedcba9876543210fedcba9876543210';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('seeding is on unless KEPLOY_SEED_RANDOM turns it off; another value is refused, naming it', () => {
  for (const v of [undefined, '', 'on', 'ON', '1', 'true', ' on ']) {
    assert.deepEqual(seedingFromEnv({ [ENV_SEED_RANDOM]: v }), { mode: 'seeded' }, String(v));
  }
  for (const v of ['off', 'OFF', 'Off', '0', 'false', ' off ']) {
    assert.deepEqual(seedingFromEnv({ [ENV_SEED_RANDOM]: v }), { mode: 'off' }, v);
  }
  for (const v of ['yes', 'no', 'seeded', '2']) {
    const s = seedingFromEnv({ [ENV_SEED_RANDOM]: v });
    assert.equal(s.mode, 'refused', v);
    assert.equal(s.refusal, `keploy: KEPLOY_SEED_RANDOM=${JSON.stringify(v)} is neither on nor off; set it to off to give the test browser its own random numbers, or unset it to seed them per test`);
  }
});

test('the lines say what is seeded, what is not, where the seed lives, and how to turn it off or on', () => {
  assert.equal(SEEDED_LINE, 'keploy: the test browser\'s random numbers (Math.random, crypto.getRandomValues, crypto.randomUUID) are seeded per test ' +
    'from a seed keploy keeps with the test\'s recording, so a replay draws the numbers its recording drew; ' +
    'Web Workers and Service Workers keep the browser\'s own, and so does a page the app opens that keploy cannot place (each one is named). ' +
    'To turn it off, record and replay with KEPLOY_SEED_RANDOM=off, or set use: { keploySeedRandom: false } in the Playwright config.');
  assert.equal(unseededLine('g › t'), 'keploy: keploy answered the begin of g › t with no seed, so its browser draws its own random numbers: ' +
    'its recording kept none (it was recorded before keploy kept seeds, or with seeding off: record the test again with seeding on, the default, to seed it), ' +
    'or the test was pulled from a Keploy branch, which keeps no seed, or this keploy predates seeds.');
  assert.equal(unplacedLine('g › t', 'http://h/p'), 'keploy: in g › t, the document at http://h/p drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is in a page the app opened that keploy cannot place in the test\'s order (a popup opened with noopener, as a link with target=_blank opens one, ' +
    'or at another origin than its opener\'s page, or after that page moved on; or a frame of another origin in one).');
  assert.equal(unplacedLine('g › t', 'http://h/p', 'popup'), unplacedLine('g › t', 'http://h/p'));
  assert.equal(unplacedLine('g › t', 'about:blank', 'own'), 'keploy: in g › t, the document at about:blank drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is in a page the test opened, and it drew before keploy named that page: a script the test added with context.addInitScript ' +
    'runs in each of the page\'s documents before keploy\'s, and so does a draw the test makes there before newPage returns.');
  assert.equal(unplacedLine('g › t', 'about:blank', 'frame'), 'keploy: in g › t, the document at about:blank drew the browser\'s own random numbers, so its draws may differ at replay: ' +
    'it is a frame keploy cannot place among its parent\'s frames (one in a closed shadow root or in an object or embed element, ' +
    'which its parent document cannot list, or one whose document began after its removal), or a frame inside one.');
});

test('an address a page sends is shown on one line, each control character a ?, cut to 512 characters', () => {
  assert.equal(pageAddress('http://h/p'), 'http://h/p');
  assert.equal(pageAddress('http://h/a\nkeploy: forged\r\u0000\u001f\u007f\tz'), 'http://h/a?keploy: forged?????z');
  assert.equal(pageAddress(`http://h/${'x'.repeat(600)}`), `http://h/${'x'.repeat(503)}`);
  assert.equal(pageAddress(42), '42');
});

test('a begin\'s seed is drawn afresh each time: 128 bits of hex, a seed keploy keeps', () => {
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const s = freshSeed();
    assert.match(s, /^[0-9a-f]{32}$/);
    assert.match(s, SEED);
    seen.add(s);
  }
  assert.equal(seen.size, 64);
  // keploy keeps 8 to 64 lower-case hex digits, as it answers them.
  for (const s of ['0123abcd', 'f'.repeat(64)]) assert.match(s, SEED, s);
  for (const s of ['', '0123abc', 'f'.repeat(65), '0123ABCD', '0123abcg', ' 0123abcd']) assert.doesNotMatch(s, SEED, s);
});

test('a seeded document draws the same numbers for the same seed and path, others for another seed or path', () => {
  const s1 = initScript(S1);
  const a = documentAt(s1, '/p').draws();
  assert.deepEqual(documentAt(s1, '/p').draws(), a);
  assert.notDeepEqual(documentAt(initScript(S2), '/p').draws(), a);
  assert.notDeepEqual(documentAt(s1, '/q').draws(), a);
  for (const r of a.random) assert.ok(r >= 0 && r < 1 && r !== 0, String(r));
  // 53 bits a draw, as the browser's own: not a 32-bit value scaled.
  const many = JSON.parse(documentAt(s1).run('JSON.stringify(Array.from({ length: 16 }, () => Math.random()))'));
  assert.ok(many.some((r) => (r * 4294967296) % 1 !== 0), many.join(' '));
  assert.match(a.uuid, UUID_V4);
  assert.equal(a.bytes.length, 8);
  // Unseeded draws differ every time.
  assert.notDeepEqual(documentAt('', '/p').draws(), documentAt('', '/p').draws());
});

test('each page the test opened draws its own numbers at one path, the same ones each run; its place is named in every document after the seeding script', () => {
  const s = initScript(S1);
  const first = documentAt(s, '/p', new Map(), 't0').draws();
  const second = documentAt(s, '/p', new Map(), 't1').draws();
  // Two tabs of one test, each in a fresh session storage, at one path: a
  // browser-made tab ID or idempotency key is not sent twice.
  assert.notEqual(second.uuid, first.uuid);
  assert.notDeepEqual(second, first);
  // Each page draws the same numbers each run (record and replay).
  assert.deepEqual(documentAt(s, '/p', new Map(), 't0').draws(), first);
  assert.deepEqual(documentAt(s, '/p', new Map(), 't1').draws(), second);
  // The page's name is read at the first draw, so the page script, which
  // the browser runs after the context's, still names it; the window shows
  // neither the name nor the seeding's state to the page's own scripts.
  const d = documentAt(s, '/p', new Map(), 't1');
  assert.deepEqual(JSON.parse(d.run(`JSON.stringify([Object.keys(globalThis).filter((k) => k.startsWith('__keploy')), globalThis[${JSON.stringify(PAGE_KEY)}], typeof globalThis[${JSON.stringify(DOC_KEY)}]])`)),
    [[], 't1', 'object']);
  assert.match(pageScript('t3'), /"t3"/);
});

test('a document no page names and no opener places draws the browser\'s own numbers, never another page\'s, and tells the fixture once, at its first draw', () => {
  const told = [];
  const s = initScript(S1, '__report');
  const d = documentAt(s, '/p', new Map(), null, { report: '__report', told });
  // Nothing is told before a draw, and the report function is taken off the
  // window as the document begins.
  assert.deepEqual(told, []);
  assert.equal(d.run('typeof globalThis.__report'), 'undefined');
  const a = d.draws();
  assert.deepEqual(told, ['http://h/p']);
  const b = d.draws();
  assert.deepEqual(told, ['http://h/p']);
  assert.notDeepEqual(b, a);
  // Not the draws of a page the test opened, at that path or any.
  assert.notDeepEqual(documentAt(s, '/p', new Map(), null).draws(), documentAt(s, '/p', new Map(), null).draws());
  assert.notDeepEqual(a, documentAt(s, '/p', new Map(), 't0').draws());
  assert.match(a.uuid, UUID_V4);
  assert.equal(a.bytes.length, 8);
  for (const r of a.random) assert.ok(r >= 0 && r < 1, String(r));
  // With no function to tell, it still draws its own.
  assert.notDeepEqual(documentAt(initScript(S1), '/p', new Map(), null).draws(), documentAt(initScript(S1), '/p', new Map(), null).draws());
  // An opaque origin tells its URL with no query or fragment, never its
  // origin's "null" before its path.
  for (const [href, at] of [['about:blank', 'about:blank'], ['about:srcdoc?q#f', 'about:srcdoc'], ['http://h/sandboxed#f', 'http://h/sandboxed']]) {
    const o = [];
    documentAt(s, 'blank', null, null, { report: '__report', told: o, origin: 'null', href }).draws();
    assert.deepEqual(o, [at], href);
  }
  const e = [];
  documentAt(s, 'blank', null, null, { report: '__report', told: e, origin: '', href: 'about:blank#x' }).draws();
  assert.deepEqual(e, ['about:blank']);
  // A window's first document with no URL yet (Firefox, as its init
  // scripts run) is about:blank.
  const none = [];
  documentAt(s, '', null, null, { report: '__report', told: none, origin: '', href: '' }).draws();
  assert.deepEqual(none, ['about:blank']);
});

test('a document loaded again in the same tab draws new numbers, the same ones each run', () => {
  const s = initScript(S1);
  const run = () => { const tab = new Map(); return [documentAt(s, '/p', tab).draws(), documentAt(s, '/p', tab).draws(), documentAt(s, '/q', tab).draws()]; };
  const [first, again, other] = run();
  assert.notDeepEqual(again, first);
  assert.deepEqual(run(), [first, again, other]);
  // Another path's count is its own: /q is its first load, as in a fresh tab.
  assert.deepEqual(other, documentAt(s, '/q').draws());
  const tab = new Map();
  documentAt(s, '/p', tab); documentAt(s, '/p', tab);
  assert.deepEqual(JSON.parse(tab.get(LOADS_KEY)), { '/p': 2 });
});

test('without session storage, or with an unreadable count, a document still draws seeded numbers', () => {
  const s = initScript(S1);
  assert.deepEqual(documentAt(s, '/p', null).draws(), documentAt(s, '/p').draws());
  for (const junk of ['not json', '[1,2]', 'null', '{"/p":"x"}']) {
    assert.deepEqual(documentAt(s, '/p', new Map([[LOADS_KEY, junk]])).draws(), documentAt(s, '/p').draws(), junk);
  }
});

test('each function has its own stream: extra draws of one do not move another\'s', () => {
  const s = initScript(S1);
  const d = documentAt(s);
  const base = documentAt(s).draws();
  d.run('for (let i = 0; i < 7; i++) Math.random();');
  const after = d.draws();
  assert.deepEqual(after.bytes, base.bytes);
  assert.equal(after.uuid, base.uuid);
  assert.notDeepEqual(after.random, base.random);
  const e = documentAt(s);
  e.run('crypto.getRandomValues(new Uint8Array(3)); crypto.randomUUID();');
  assert.deepEqual(e.draws().random, base.random);
});

test('getRandomValues fills the array it was given and returns it; what the browser refuses it still refuses', () => {
  const d = documentAt(initScript(S1));
  assert.equal(d.run('(() => { const a = new Uint32Array(5); return crypto.getRandomValues(a) === a && a.some((x) => x !== 0); })()'), true);
  // A view into the middle of a buffer is filled there only.
  assert.equal(d.run('(() => { const b = new Uint8Array(12); crypto.getRandomValues(new Uint8Array(b.buffer, 4, 4)); return b.slice(0, 4).every((x) => x === 0) && b.slice(8).every((x) => x === 0); })()'), true);
  assert.throws(() => d.run('crypto.getRandomValues(new Float32Array(2))'));
  assert.throws(() => d.run('crypto.getRandomValues(new Uint8Array(65537))'));
  // Called on a this that is no Crypto, either function throws as the
  // browser's own does, and draws nothing from its stream.
  const f = documentAt(initScript(S1));
  assert.throws(() => f.run('crypto.getRandomValues.call({}, new Uint8Array(4))'), /Illegal invocation/);
  assert.throws(() => f.run('crypto.randomUUID.call({})'), /Illegal invocation/);
  assert.throws(() => f.run('Crypto.prototype.randomUUID()'), /Illegal invocation/);
  assert.throws(() => f.run('crypto.getRandomValues(new Float32Array(2))'));
  assert.deepEqual(f.draws(), documentAt(initScript(S1)).draws());
  // The functions keep their names and lengths, and stay on the prototype.
  assert.deepEqual(JSON.parse(d.run('JSON.stringify([Math.random.name, Math.random.length, crypto.getRandomValues.name, crypto.getRandomValues.length, crypto.randomUUID.name, Object.keys(crypto).length])')),
    ['random', 0, 'getRandomValues', 1, 'randomUUID', 0]);
});

test('a document without crypto.randomUUID (not a secure context) is not given one', () => {
  class Crypto { getRandomValues(a) { return a; } }
  const d = documentAt('');
  d.ctx.Crypto = Crypto;
  d.ctx.crypto = new Crypto();
  d.run(initScript(S1));
  assert.equal(d.run('typeof crypto.randomUUID'), 'undefined');
  assert.equal(d.run('typeof Math.random()'), 'number');
});

test('a page the test asked for is the test\'s own when its first document tells while its newPage has not come; it is named in the order the test asked', async () => {
  // A context whose pages come only when the row says, so the order is the
  // row's, not the browser's.
  const asked = [];
  const original = function newPage() { return new Promise((resolve) => asked.push(resolve)); };
  const context = { newPage: original };
  const fakePage = () => {
    const scripts = [];
    return { scripts, addInitScript: async (s) => { scripts.push(s.content); }, evaluate: async (s) => { scripts.push(s); } };
  };
  const placing = placePages(context);
  const first = fakePage(), second = fakePage(), popup = fakePage();
  const a = context.newPage(), b = context.newPage();
  // Both first documents tell before either newPage has come.
  const firstOwn = placing.opened(first), secondOwn = placing.opened(second), popupOwn = placing.opened(popup);
  // The second comes first: each keeps the place it was asked in.
  asked[1](second);
  asked[0](first);
  assert.equal(await a, first);
  assert.equal(await b, second);
  assert.deepEqual([await firstOwn, await secondOwn, await popupOwn], [true, true, false]);
  assert.deepEqual(first.scripts, [pageScript('t0'), pageScript('t0')]);
  assert.deepEqual(second.scripts, [pageScript('t1'), pageScript('t1')]);
  // After they came, and with none coming.
  assert.deepEqual([await placing.opened(first), await placing.opened(second), await placing.opened(popup), await placing.opened(null)], [true, true, false, false]);
  placing.restore();
  assert.equal(context.newPage, original);
  // A context whose newPage is its prototype's gets the prototype's back.
  const proto = { newPage: original };
  const inherited = Object.create(proto);
  placePages(inherited).restore();
  assert.equal(Object.prototype.hasOwnProperty.call(inherited, 'newPage'), false);
  assert.equal(inherited.newPage, original);
});

// A frame element of a document the row makes: its tag, the window it
// holds, its src (null for none), whether it has srcdoc, and the shadow
// root it hosts.
const el = (localName, contentWindow, src = null, { srcdoc = false, shadow = null } = {}) => ({
  localName, contentWindow, shadowRoot: shadow,
  getAttribute: (n) => (n === 'src' ? src : null),
  hasAttribute: (n) => n === 'srcdoc' && srcdoc,
});
// A document (or shadow root) whose elements, in tree order, are els.
const tree = (els, baseURI = 'https://h/host') => ({ baseURI, querySelectorAll: (q) => { assert.equal(q, '*'); return els; } });

test('a document numbers its frames at the path each element asks for, in element order, whatever order their documents begin in, and counts each place\'s loads', () => {
  const w = (n) => ({ n });
  const [r0, r1, a, a2, b, sd, none, empty, blob, data, other, bad, fr, sh, closed, emb, gone] = Array.from({ length: 17 }, (_, i) => w(i));
  const els = [
    el('iframe', r0, '/fr?n=0'), el('div', null, null, { shadow: tree([el('iframe', sh, '/fr')]) }), el('iframe', a, '/fa'), el('iframe', r1, 'https://cdn.example/fr#x'),
    el('iframe', sd, '/ignored', { srcdoc: true }), el('iframe', none), el('iframe', empty, ''), el('iframe', blob, 'blob:https://h/5d3c'),
    el('iframe', data, 'data:text/html,<p>'), el('iframe', other, 'mailto:x'), el('iframe', bad, 'http://['), el('frame', fr, '/fb'),
    el('embed', emb, '/fa'), el('iframe', null, '/fr'),
  ];
  const doc = tree(els);
  const doc0 = documentAt(initScript(S1), '/host', new Map(), 't0', { doc }).run(`globalThis[${JSON.stringify(DOC_KEY)}]`);
  // What enter answers, or what it threw.
  const d = { enter: (x, p) => { try { return [...doc0.enter(x, p)]; } catch (e) { return String(e); } } };
  // r1's document begins first: still the second at /fr, after r0, and
  // after sh, in the shadow root of the element before a.
  assert.deepEqual(d.enter(r1, '/fr'), ['f/fr\n2', 0]);
  assert.deepEqual(d.enter(sh, '/fr'), ['f/fr\n1', 0]);
  assert.deepEqual(d.enter(r0, '/fr'), ['f/fr\n0', 0]);
  // Each place counts the documents of each path it loads.
  assert.deepEqual(d.enter(r1, '/fr'), ['f/fr\n2', 1]);
  assert.deepEqual(d.enter(r1, '/fb'), ['f/fr\n2', 0]);
  assert.deepEqual(d.enter(r0, '/fr'), ['f/fr\n0', 1]);
  assert.deepEqual(d.enter(a, '/fa'), ['f/fa\n0', 0]);
  // srcdoc, no src, an empty src, other schemes (by scheme alone: a blob:
  // URL carries a browser-made ID), a src keploy cannot read, a frameset's
  // frame.
  for (const [x, at] of [[sd, 'about:srcdoc\n0'], [none, 'about:blank\n0'], [empty, 'about:blank\n1'], [blob, 'blob:\n0'], [data, 'data:\n0'], [other, 'mailto:\n0'], [bad, '?\n0'], [fr, '/fb\n0']]) {
    assert.deepEqual(d.enter(x, 'p'), [`f${at}`, 0], at);
  }
  // A window no element of the document holds (an embed's, one in a closed
  // shadow root, a removed one) has no place.
  for (const x of [emb, closed, gone]) assert.deepEqual(d.enter(x, '/fa'), [null, 0]);
  // a removed, and a2 put in at its path: a2 takes the next number there;
  // a keeps its place.
  els.splice(2, 1, el('iframe', a2, '/fa'));
  assert.deepEqual(d.enter(a2, '/fa'), ['f/fa\n1', 0]);
  assert.deepEqual(d.enter(a, '/fa'), ['f/fa\n0', 1]);
  // Put in another order, the same frames take the same places.
  const e2 = documentAt(initScript(S1), '/host', new Map(), 't0', { doc: tree([el('iframe', b, '/fb'), el('iframe', w(), '/fx'), el('iframe', r0, '/fr'), el('iframe', r1, '/fr')]) }).run(`globalThis[${JSON.stringify(DOC_KEY)}]`);
  assert.deepEqual([...e2.enter(r1, '/fr')], ['f/fr\n1', 0]);
  assert.deepEqual([...e2.enter(b, '/fb')], ['f/fb\n0', 0]);
});

test('a frame of its parent\'s origin draws in its parent document\'s key and its place there; one under a parent of another origin, in its page by its path; one with no place draws its own and says why', () => {
  const at = 'http://h/f';
  // Placed by its parent: the parent's key, its place, its own path and
  // its loads in that place; session storage untouched.
  const asked = [];
  const parent = { [DOC_KEY]: { enter: (w, p) => { asked.push(p); return ['f/f\n3', 2]; }, key: () => 'K\n', why: () => 'unused' } };
  const store = new Map();
  const placed = documentAt(initScript(S1), '/f', store, null, { parent });
  assert.deepEqual(placed.draws(), documentAt(initScript(S1), '/f', new Map([[LOADS_KEY, '{"/f":2}']]), 'K\nf/f\n3').draws());
  assert.deepEqual(asked, ['/f']);
  assert.equal(store.size, 0);
  // Under a parent of another origin: its page, marked, its path, and its
  // origin's count in the tab.
  const tab = new Map([[LOADS_KEY, '{"/f":1}']]);
  assert.deepEqual(documentAt(initScript(S1), '/f', tab, 't0', { parent: OTHER }).draws(), documentAt(initScript(S1), '/f', new Map([[LOADS_KEY, '{"/f":1}']]), 't0x').draws());
  assert.equal(tab.get(LOADS_KEY), '{"/f":2}');
  // In a page no page script names, it has no place, and says so with no
  // reason of its own.
  const none = [];
  const u = documentAt(initScript(S1, 'rep'), '/f', new Map(), null, { parent: OTHER, report: 'rep', told: none });
  assert.notDeepEqual(u.draws(), u.draws());
  assert.deepEqual(none, [at]);
  // A frame its parent cannot place, one whose parent is gone, and one
  // whose parent has no seeding state: no place, the frame reason.
  for (const p of [{ [DOC_KEY]: { enter: () => [null, 0], key: () => 'K\n', why: () => '' } }, null, {}]) {
    const told = [];
    const f = documentAt(initScript(S1, 'rep'), '/f', new Map(), 't0', { parent: p, report: 'rep', told });
    let drew = [];
    try { drew = [f.draws(), f.draws()]; } catch (e) { drew = [String(e)]; }
    assert.deepEqual(told, [[at, 'frame']]);
    assert.notDeepEqual(drew[0], drew[1]);
  }
  // A frame placed in a parent with no place: no place, its parent's
  // reason.
  for (const why of ['', 'frame']) {
    const told = [];
    documentAt(initScript(S1, 'rep'), '/f', new Map(), 't0', { parent: { [DOC_KEY]: { enter: () => ['f/f\n0', 0], key: () => null, why: () => why } }, report: 'rep', told }).draws();
    assert.deepEqual(told, [why ? [at, why] : at], why);
  }
});

test('a document that a second run of the script takes over (WebKit runs it in a document that takes over its window\'s first about:blank) begins once: the first run passes on the browser\'s own', () => {
  const store = new Map();
  const blank = { baseURI: 'about:blank', querySelectorAll: () => [] };
  // The window's first about:blank runs the script; a window.open of its
  // own is there to be wrapped.
  const d = documentAt(`globalThis.open = function () { return {}; };\n${initScript(S1)}`, 'blank', store, 't0', { doc: blank });
  // Its document is taken over by /p, which runs the script again.
  d.ctx.document = { baseURI: 'http://h/p', querySelectorAll: () => [] };
  d.ctx.location.pathname = '/p';
  d.run(initScript(S1));
  d.run(pageScript('t0'));
  // getRandomValues and randomUUID call the first run's functions first,
  // and a popup goes through its window.open: /p is still counted once.
  const drew = d.draws();
  d.run('open()');
  assert.equal(store.get(LOADS_KEY), '{"blank":1,"/p":1}');
  assert.deepEqual(drew, documentAt(initScript(S1), '/p', new Map(), 't0').draws());
});
