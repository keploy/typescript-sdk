import http from 'http';
import { add, mul } from './calc';

const server = http.createServer((req, res) => {
  if (req.url === '/add') {
    res.end(String(add(2, 3)));
    return;
  }
  if (req.url === '/mul') {
    res.end(String(mul(2, 3)));
    return;
  }
  res.statusCode = 404;
  res.end('no');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${(server.address() as { port: number }).port}\n`);
});
