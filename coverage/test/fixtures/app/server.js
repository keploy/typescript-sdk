'use strict';
const http = require('http');
const lib = require('./lib');
const price = require('./compiled/price');

const server = http.createServer((req, res) => {
  if (req.url === '/a') {
    res.end(String(lib.alpha(2)));
    return;
  }
  if (req.url === '/b') {
    res.end(String(lib.beta(3)));
    return;
  }
  if (req.url === '/price') {
    const cart = new price.Cart();
    cart.add({ sku: 'x', cents: 250 });
    res.end(String(price.discount(price.total([{ sku: 'x', cents: 250 }]), 10)));
    return;
  }
  res.statusCode = 404;
  res.end('no');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
