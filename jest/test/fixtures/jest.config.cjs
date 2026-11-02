// The rows' Jest config: the environment under test, built (npm run build).
const path = require('node:path');
module.exports = {
  rootDir: __dirname,
  testEnvironment: path.join(__dirname, '..', '..', 'dist', 'index.js'),
  testMatch: ['<rootDir>/**/*.test.js'],
  ...(process.env.KJ_DISPLAY_NAME ? { displayName: process.env.KJ_DISPLAY_NAME } : {}),
};
