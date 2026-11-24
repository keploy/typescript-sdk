'use strict';
// A load-time transform, as pirates / @babel/register do: lib.js runs as
// other bytes than the file holds. (A *.test.js name: no unit of the table.)
const Module = require('module');
const fs = require('fs');
const orig = Module._extensions['.js'];
Module._extensions['.js'] = function (m, filename) {
  if (filename.endsWith(`${require('path').sep}lib.js`)) {
    const code = fs.readFileSync(filename, 'utf8').replace('n * 2', 'n * 2 /* transformed */');
    return m._compile(code, filename);
  }
  return orig(m, filename);
};
require('./server.js');
