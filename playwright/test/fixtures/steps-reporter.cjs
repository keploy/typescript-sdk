// The rows' reporter of every step a test ran, hooks' and fixtures' included
// (Playwright's JSON report keeps only steps at the test's top level): one
// JSON line {test, step, at, start} per step begun, appended to STEPS_FILE;
// at is the step's file name and line, '' for none; start is when the
// worker said the step began (its Date.now()), in milliseconds.
const fs = require('node:fs');
const path = require('node:path');

class StepsReporter {
  onStepBegin(test, _result, step) {
    if (process.env.STEPS_FILE) fs.appendFileSync(process.env.STEPS_FILE, `${JSON.stringify({ test: test.title, step: step.title, at: step.location ? `${path.basename(step.location.file)}:${step.location.line}` : '', start: step.startTime ? step.startTime.getTime() : null })}\n`);
  }
}
module.exports = StepsReporter;
