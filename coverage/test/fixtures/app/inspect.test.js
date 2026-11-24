'use strict';
// Another inspector client enables the Profiler and disables it again, as a
// debugger that attaches and detaches does: V8 leaves precise coverage.
const inspector = require('inspector');
const s = new inspector.Session();
s.connect();
s.post('Profiler.enable', () => {
  s.post('Profiler.disable', () => require('./server.js'));
});
