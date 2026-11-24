'use strict';
// An app that runs part of a request in a worker thread: one of its own
// files (/w) or an eval string (/e), as pool libraries do.
const http = require('http');
const path = require('path');
const { Worker } = require('worker_threads');
const lib = require('./lib');

const server = http.createServer((req, res) => {
  if (req.url === '/w' || req.url === '/e') {
    const w = req.url === '/w'
      ? new Worker(path.join(__dirname, 'work.test.js'))
      : new Worker("require('worker_threads').parentPort.postMessage(1)", { eval: true });
    w.once('message', (m) => res.end(String(m)));
    return;
  }
  res.end(String(lib.alpha(1)));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${server.address().port}\n`));
