// The code under test: a shop that prices, reserves and charges through a
// provider over HTTP (Node's own client, keep-alive as Node sets it).
const http = require('node:http');

const BASE = new URL(process.env.SHOP_PROVIDER || 'http://127.0.0.1:18731');

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: BASE.hostname,
      port: BASE.port,
      method,
      path,
      headers: data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${method} ${path}: HTTP ${res.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`${method} ${path}: not JSON: ${text}`)); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

exports.price = async (item) => (await call('GET', `/price/${item}`)).cents;
exports.reserve = async (item) => (await call('POST', '/reserve', { item })).ok;
exports.charge = async (cents) => (await call('POST', '/charge', { cents })).status;
