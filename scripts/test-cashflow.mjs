import assert from 'node:assert/strict';
import { calculateCashflow, cashflowExamples } from '../src/lib/cashflow.js';

const cafe = calculateCashflow(cashflowExamples.cafe);
assert.equal(cafe.base.rows[6].balance, 108000);
assert.equal(cafe.stress.rows[6].balance, 50400);
assert.equal(cafe.base.firstShortfall, null);
const delayed = calculateCashflow({ ...cashflowExamples.cafe, delay: 2 });
assert.equal(delayed.base.rows[2].balance, -20000);
assert.equal(delayed.base.firstShortfall, 2);
assert.equal(delayed.base.reserve, 20000);
assert.equal(delayed.base.rows[6].balance, 12000); // Recovery does not erase the cash gap.
const upfront = calculateCashflow({ ...cashflowExamples.cafe, cash: 100000 });
assert.equal(upfront.base.firstShortfall, 0);
assert.equal(upfront.base.reserve, 40000);
const closed = calculateCashflow({ ...cashflowExamples.cafe, delay: 6 });
assert.equal(closed.base.rows[6].balance, -180000);
const noSales = calculateCashflow({ ...cashflowExamples.cafe, stress: 100 });
assert.equal(noSales.stress.rows[6].balance, -180000);
const zero = calculateCashflow({ cash: 0, setup: 0, fixed: 0, sales: 0, variable: 0, delay: 0, stress: 0 });
assert.equal(zero.base.firstShortfall, null);
assert.equal(zero.base.reserve, 0);
for (const invalid of [{ cash: NaN }, { sales: Infinity }, { setup: -1 }, { fixed: 100000001 }, { variable: 101 }, { delay: 1.5 }, { delay: 7 }, { stress: -1 }]) {
  assert.throws(() => calculateCashflow({ ...cashflowExamples.cafe, ...invalid }), RangeError);
}
for (const example of Object.values(cashflowExamples)) {
  for (const scenario of Object.values(calculateCashflow(example))) {
    let previous = example.cash;
    for (const row of scenario.rows) {
      assert.equal(Math.round(row.balance * 100), Math.round((previous + row.receipts - row.payments) * 100));
      previous = row.balance;
    }
  }
}
console.log('Cashflow checks passed: deficit timing, recovery, delays, examples and invalid inputs.');
