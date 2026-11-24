// An app Node runs as TypeScript itself (type stripping).
import http from 'node:http';

function twice(n: number): number {
  return n * 2;
}

const server = http.createServer((req, res) => {
  res.end(String(twice(21)));
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address() as { port: number };
  process.stdout.write(`PORT ${addr.port}\n`);
});
