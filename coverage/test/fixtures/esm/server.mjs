// An ES module app: V8 names its scripts by file: URL.
import http from 'node:http';
import { greet } from './greet.mjs';

const server = http.createServer((req, res) => {
  res.end(greet(req.url));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
