import fs from 'node:fs';
import { test } from '../../dist';

test('set aside', async () => {
  fs.writeFileSync(`${process.env.MARKER_DIR}/set-aside-ran`, '1');
});
test('judged red', async () => {});
test('refused', async () => {
  fs.writeFileSync(`${process.env.MARKER_DIR}/refused-ran`, '1');
});
