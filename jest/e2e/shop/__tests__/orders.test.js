const { price, reserve } = require('../src/shop');

// SHOP_CHANGE: the change a replay of e2e/lane.sh makes to the code under
// test. miss: the price test asks for a pen, which no recorded call answers.
// unconsumed: the reserve test no longer makes its recorded call.
const change = process.env.SHOP_CHANGE || '';

describe('orders', () => {
  test('prices a book', async () => {
    expect(await price(change === 'miss' ? 'pen' : 'book')).toBe(change === 'miss' ? 150 : 4200);
  });

  test('reserves a book', async () => {
    if (change === 'unconsumed') return;
    expect(await reserve('book')).toBe(true);
  });
});
