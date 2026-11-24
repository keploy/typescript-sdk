'use strict';
// A cluster app: the primary forks a worker that serves the requests.
const cluster = require('cluster');
if (cluster.isPrimary || cluster.isMaster) {
  cluster.fork();
} else {
  require('./server.js');
}
