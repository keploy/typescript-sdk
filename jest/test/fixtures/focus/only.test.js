const log = require('./../log.cjs');
test('not focused', () => log('body not focused'));
test.only('focused', () => log('body focused'));
describe.only('focused group', () => {
  test('inside', () => log('body inside'));
});
