// The note a seeded test leaves with its recording, and what its replay says
// when it draws otherwise.
//
// A recording keeps a test's seed, not its numbers, so a replay draws what
// its recording drew only while each stream is drawn in the same order and
// the same number of times. Some things move a draw between runs and no
// seeding can place them: frames at one path put in in another order or
// number, a worker fixture or a library that draws in whichever test first
// needs it, a draw made a varying number of times. The record's end sends
// keploy a note of how many times each stream was drawn and how many frames
// each document put in at each path; keploy keeps it with the test's
// recording, never reads it, and answers it to the replay's begin. The
// replay's end compares and prints one line for each difference, naming the
// test, what differs and the next step.

import { MAX_NOTE } from './agent';
import { pageAddress } from './random';

export { MAX_NOTE };

/** The version of the note this package writes and reads. */
export const NOTE_VERSION = 1;

/** The functions a document's draws are counted for, in a count's order. */
export const DOC_FUNCTIONS = ['Math.random', 'crypto.getRandomValues', 'crypto.randomUUID'] as const;

/**
 * What one document drew and put in: at, its address (for the lines); n,
 * how many times it drew each of DOC_FUNCTIONS; f, how many frames it put in
 * at each path.
 */
export type DocDraws = { at: string; n: number[]; f: Record<string, number> };

/**
 * A test's note: v, NOTE_VERSION; p, how many times the test process drew
 * each of its streams; d, each document's draws by its place (the key its
 * streams are made from, without the seed); cut, how many documents and
 * streams were left out to keep the note within MAX_NOTE.
 */
export type TestNote = { v: number; p: Record<string, number>; d: Record<string, DocDraws>; cut: number };

/** At most this many documents are kept for one test, the rest are cut. */
export const MAX_DOCS = 1000;

/** At most this many difference lines are printed for one test. */
export const MAX_LINES = 8;

/**
 * What a test's documents drew: docs, each one's by its place; dropped, the
 * places of those left out once MAX_DOCS were kept.
 */
export type DocLog = { docs: Map<string, DocDraws>; dropped: Set<string> };

export function docLog(): DocLog {
  return { docs: new Map(), dropped: new Set() };
}

/**
 * Keeps one report of a document's draws (the seeding's in the page sends
 * one after each task in which the document drew or numbered a frame): the
 * counts only grow, so each is the larger of the two. A report that is not
 * a document's draws is not kept, nor is a new document once MAX_DOCS are.
 */
export function keepDocDraws(log: DocLog, key: unknown, at: unknown, n: unknown, f: unknown): void {
  if (typeof key !== 'string' || key === '' || !Array.isArray(n) || n.length !== DOC_FUNCTIONS.length || !n.every(count)) return;
  if (f === null || typeof f !== 'object' || Array.isArray(f) || !Object.values(f).every(count)) return;
  const docs = log.docs;
  const had = docs.get(key);
  if (had === undefined && docs.size >= MAX_DOCS) {
    log.dropped.add(key);
    return;
  }
  const frames: Record<string, number> = { ...had?.f };
  for (const [p, c] of Object.entries(f as Record<string, number>)) frames[p] = Math.max(frames[p] ?? 0, c);
  docs.set(key, {
    at: had?.at ?? pageAddress(at),
    n: (n as number[]).map((c, i) => Math.max(had?.n[i] ?? 0, c)),
    f: frames,
  });
}

function count(c: unknown): c is number {
  return typeof c === 'number' && Number.isSafeInteger(c) && c >= 0;
}

/**
 * The note of a test that drew process from its test process's streams and
 * log in its documents, as JSON of at most MAX_NOTE UTF-8 bytes: the
 * documents that would take it past the bound are cut, the last kept first,
 * then the streams, the last drawn first (a stream's name is the suite's
 * own when it seeds a faker instance under a long name); they are counted,
 * and so are the documents keepDocDraws did not keep. A note with neither
 * is always within the bound.
 */
export function noteText(process: ReadonlyMap<string, number>, log: DocLog): string {
  const entries = [...log.docs];
  const streams = [...process];
  for (;;) {
    const cut = log.dropped.size + log.docs.size - entries.length + process.size - streams.length;
    const text = JSON.stringify({ v: NOTE_VERSION, p: Object.fromEntries(streams), d: Object.fromEntries(entries), cut } satisfies TestNote);
    if (Buffer.byteLength(text, 'utf8') <= MAX_NOTE) return text;
    if (entries.length > 0) entries.pop();
    else streams.pop();
  }
}

/**
 * The note a recording kept, read; a string that says why it cannot be read
 * instead (another version's, or no note of this package's).
 */
export function readNote(text: string): TestNote | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return 'it is not JSON';
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'it is not an object';
  const o = v as Record<string, unknown>;
  if (o.v !== NOTE_VERSION) return `it is version ${JSON.stringify(o.v ?? null)}, and this @keploy/playwright reads version ${NOTE_VERSION}`;
  const p = o.p, d = o.d, cut = o.cut;
  if (p === null || typeof p !== 'object' || Array.isArray(p) || !Object.values(p).every(count)) return 'its test process counts are not counts';
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return 'its documents are not an object';
  for (const doc of Object.values(d as Record<string, unknown>)) {
    const x = doc as Partial<DocDraws> | null;
    if (x === null || typeof x !== 'object' || typeof x.at !== 'string' || !Array.isArray(x.n) || x.n.length !== DOC_FUNCTIONS.length || !x.n.every(count) ||
      x.f === null || typeof x.f !== 'object' || Array.isArray(x.f) || !Object.values(x.f).every(count)) return 'a document\'s counts are not counts';
  }
  if (!count(cut)) return 'its cut is not a count';
  return { v: NOTE_VERSION, p: p as Record<string, number>, d: d as Record<string, DocDraws>, cut };
}

const TIMES = (n: number): string => (n === 1 ? 'once' : `${n} times`);

const PROCESS_NEXT = 'so its draws from that stream after the first one that differs are not the recording\'s, nor is what the test makes from them. ' +
  'In the test process: register a worker fixture with this package\'s test.extend (one registered through @playwright/test\'s own test, ' +
  'or through a test type mergeTests returned, draws in whichever test first asks for it); use a library that draws on its first use once ' +
  'outside the tests (in a worker fixture of this package\'s test); and draw a fixed number of times (a retry loop\'s jitter draws a varying number)';

const DOC_NEXT = 'so its draws of that function after the first one that differs are not the recording\'s: ' +
  'a draw made a varying number of times (one for each timer tick, a retry\'s jitter) shifts the ones after it, ' +
  'and a frame at a path where frames are put in in a varying order or number may take another frame\'s place; ' +
  'draw a fixed number of times, and give each frame its own path';

const FRAME_NEXT = 'so the frames at that path may take other places than in the recording and draw other numbers: ' +
  'give each frame at that path its own src path, or put them in in a fixed order and number';

/**
 * The lines a replay of test name prints where it drew otherwise than its
 * recording (recorded: the recording's note; now: this replay's): one for
 * each stream of the test process drawn another number of times, each
 * function a document drew another number of times, and each path at which
 * a document put in another number of frames; at most MAX_LINES, then one
 * that says how many more. A stream or a document one note cut is compared
 * with nothing.
 */
export function differences(name: string, recorded: TestNote, now: TestNote): string[] {
  const lines: string[] = [];
  const streams = [...new Set([...Object.keys(recorded.p), ...Object.keys(now.p)])];
  for (const s of streams) {
    // A stream a note cut is not known to differ.
    if ((recorded.p[s] === undefined && recorded.cut > 0) || (now.p[s] === undefined && now.cut > 0)) continue;
    const r = recorded.p[s] ?? 0, n = now.p[s] ?? 0;
    if (r !== n) lines.push(`keploy: ${name} drew ${s} ${TIMES(n)} in the test process at this replay and ${TIMES(r)} in its recording, ${PROCESS_NEXT}.`);
  }
  const keys = [...new Set([...Object.keys(recorded.d), ...Object.keys(now.d)])];
  for (const k of keys) {
    const r = recorded.d[k], n = now.d[k];
    // A document a note cut is not known to differ.
    if ((r === undefined && recorded.cut > 0) || (n === undefined && now.cut > 0)) continue;
    const at = n?.at ?? r?.at ?? '';
    DOC_FUNCTIONS.forEach((fn, i) => {
      const rc = r?.n[i] ?? 0, nc = n?.n[i] ?? 0;
      if (rc !== nc) lines.push(`keploy: ${name}: the document at ${at} drew ${fn} ${TIMES(nc)} at this replay and ${TIMES(rc)} in its recording, ${DOC_NEXT}.`);
    });
    const paths = [...new Set([...Object.keys(r?.f ?? {}), ...Object.keys(n?.f ?? {})])];
    for (const p of paths) {
      const rc = r?.f[p] ?? 0, nc = n?.f[p] ?? 0;
      if (rc !== nc) lines.push(`keploy: ${name}: the document at ${at} put in ${nc} frame(s) at ${pageAddress(p)} at this replay and ${rc} in its recording, ${FRAME_NEXT}.`);
    }
  }
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `keploy: ${name} drew otherwise than its recording in ${lines.length - MAX_LINES} more way(s) than the lines above name.`];
}

/**
 * The line a seeded replay prints, once per worker, when keploy answered
 * its begin with no note, so a difference in its draws cannot be named.
 */
export const NO_NOTE_LINE = 'keploy: keploy answered a seeded replay\'s begin with no note of how its recording drew, so where a test draws otherwise than its recording, ' +
  'no line names it: the recording keeps none (it was recorded with keploy v3.7.5 or older, or with @keploy/playwright 0.1.1 or older), ' +
  'or this keploy keeps none (keploy v3.7.5 or older). Record the tests again with a keploy that keeps notes to have each difference named.';

/** The line a replay prints when its recording's note cannot be read (why). */
export function unreadNoteLine(name: string, why: string): string {
  return `keploy: the note keploy kept of how ${name}'s recording drew cannot be read (${why}), so where its replay draws otherwise, no line names it: ` +
    'record the test again with this @keploy/playwright.';
}
