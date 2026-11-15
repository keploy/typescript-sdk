// Rows for test/webkit.mjs: the browser rows take WebKit's dropped Shared
// Worker only on exactly its record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webkitDroppedLine, webkitDroppedSharedWorker } from './webkit.mjs';

// What the server saw in a run of served.spec.ts where WebKit dropped the
// Shared Worker (as recorded with plain Playwright, no keploy): /rds/s.js and
// /rds/v2/s.js once each, then the next worker's script; no /rds/v2/h.js.
const DROPPED = ['/sv', '/sv/l1.js', '/sv/l1.js', '/sv', '/sv/cn.js', '/sv/csn.js', '/sv/ctt.js', '/sv/cn.js', '/sv/cn.js', '/sv', '/rd/w.js', '/rd/v2/w.js', '/rd/v2/h.js', '/rdm/m.js', '/rdm/v2/m.js', '/rdm/v2/h.mjs', '/rds/s.js', '/rds/v2/s.js', '/rd/w.js', '/rd/v2/w.js', '/rd/v2/h.js', '/sv', '/sv/sn.js', '/sv/snm.js'];
const at = (i, ...us) => [...DROPPED.slice(0, i), ...us, ...DROPPED.slice(i)];
const without = (u) => DROPPED.filter((x) => x !== u);
const S = DROPPED.indexOf('/rds/v2/s.js') + 1;

test("webkitDroppedSharedWorker: WebKit's dropped Shared Worker is taken only on exactly its record (WebKit, no message and no error event, /rds/s.js and /rds/v2/s.js served once each, /rds/v2/h.js never); any other engine, answer or record is not", () => {
  assert.equal(webkitDroppedSharedWorker('webkit', 'none', DROPPED), true);
  const not = [
    ['chromium', 'none', DROPPED, 'another engine'],
    ['firefox', 'none', DROPPED, 'another engine'],
    ['webkit', 'error', DROPPED, 'an error event'],
    ['webkit', { k: 'rds', H: 'v2' }, DROPPED, 'a message'],
    ['webkit', undefined, DROPPED, 'nothing kept'],
    ['webkit', 'none', at(S, '/rds/s.js'), "the first URL asked twice (seeded WebKit's record)"],
    ['webkit', 'none', without('/rds/s.js'), 'the first URL never asked'],
    ['webkit', 'none', without('/rds/v2/s.js'), "the redirect's URL never asked"],
    ['webkit', 'none', at(S, '/rds/v2/s.js'), "the redirect's URL asked twice"],
    ['webkit', 'none', at(S, '/rds/v2/h.js'), 'the import asked'],
    ['webkit', 'none', at(S, '/rds/v2/h.js', '/rds/v2/h.js'), 'the import asked twice'],
    ['webkit', 'none', [], 'nothing asked'],
  ];
  for (const [engine, got, seen, why] of not) assert.equal(webkitDroppedSharedWorker(engine, got, seen), false, why);
  assert.match(webkitDroppedLine('off'), /^WebKit dropped the redirected Shared Worker \/rds\/s\.js in the off run: .*WebKit's own defect \(the same with no keploy\)/);
});
