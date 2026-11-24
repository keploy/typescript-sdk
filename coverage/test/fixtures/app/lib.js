'use strict';
// Two functions, each on lines of its own.

function alpha(n) {
  const twice = n * 2;
  return twice + 1;
}

function beta(n) {
  const thrice = n * 3;
  return thrice - 1;
}

module.exports = { alpha, beta };
