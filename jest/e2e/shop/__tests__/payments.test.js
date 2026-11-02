const { charge } = require('../src/shop');

test('charges a card', async () => {
  expect(await charge(4200)).toBe('captured');
});
