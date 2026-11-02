// The provider the shop calls: up while keploy records, stopped while it
// replays. Prints "ready" once it listens.
const http = require('node:http');

const PRICES = { book: 4200, pen: 150 };
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let answer;
    if (req.method === 'GET' && req.url.startsWith('/price/')) answer = { cents: PRICES[req.url.slice('/price/'.length)] ?? 0 };
    else if (req.method === 'POST' && req.url === '/reserve') answer = { ok: JSON.parse(body).item in PRICES };
    else if (req.method === 'POST' && req.url === '/charge') answer = { status: JSON.parse(body).cents > 0 ? 'captured' : 'declined' };
    else { res.writeHead(404); res.end('no route'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
}).listen(port, '127.0.0.1', () => console.log('ready'));
