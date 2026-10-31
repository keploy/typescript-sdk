// The rows' reporter of every step a test ran, hooks' and fixtures' included
// (Playwright's JSON report keeps only steps at the test's top level): one
// JSON line {test, step} per step begun, appended to STEPS_FILE.
const fs = require('node:fs');

class StepsReporter {
  onStepBegin(test, _result, step) {
    if (process.env.STEPS_FILE) fs.appendFileSync(process.env.STEPS_FILE, `${JSON.stringify({ test: test.title, step: step.title })}\n`);
  }
}
module.exports = StepsReporter;
