// Appends one line to the row's journal, which the fake agent writes too.
const fs = require('node:fs');
module.exports = (s) => fs.appendFileSync(process.env.KJ_JOURNAL, `${s}\n`);
