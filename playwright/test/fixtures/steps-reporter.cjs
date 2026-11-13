// The rows' reporter of every step a test ran, hooks' and fixtures' included
// (Playwright's JSON report keeps only steps at the test's top level): one
// JSON line {test, step, at} per step begun, appended to STEPS_FILE; at is
// the step's file name and line, '' for none. And one line {test, out} for
// each write to a test's stdout, in the same file, so that a row can tell
// whether a test's line came before or after one of its steps.
const fs = require('node:fs');
const path = require('node:path');

class StepsReporter {
  onStepBegin(test, _result, step) {
    if (process.env.STEPS_FILE) fs.appendFileSync(process.env.STEPS_FILE, `${JSON.stringify({ test: test.title, step: step.title, at: step.location ? `${path.basename(step.location.file)}:${step.location.line}` : '' })}\n`);
  }

  onStdOut(chunk, test) {
    if (process.env.STEPS_FILE && test) fs.appendFileSync(process.env.STEPS_FILE, `${JSON.stringify({ test: test.title, out: String(chunk) })}\n`);
  }
}
module.exports = StepsReporter;
