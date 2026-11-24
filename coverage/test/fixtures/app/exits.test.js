'use strict';
// A main script that ends by process.exit: the adapter removes its control
// socket on the way out. (A *.test.js name: no unit of the app's table.)
process.stdout.write('PORT 0\n');
setTimeout(() => process.exit(0), 300);
