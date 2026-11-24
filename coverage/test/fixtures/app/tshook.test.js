'use strict';
// A require hook for .ts, as ts-node registers: the app's TypeScript is
// compiled in memory. (A *.test.js name: no unit of the table.)
require.extensions['.ts'] = require.extensions['.js'];
require('./server.js');
