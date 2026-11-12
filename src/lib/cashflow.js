// All money is calculated in kopecks. Receipts and variable payments occur
// in the same month; fixed payments continue while opening is delayed.
export const cashflowExamples = {
  cafe: { label: 'Кав’ярня', cash: 200000, setup: 140000, fixed: 40000, sales: 80000, variable: 40, delay: 0, stress: 20 },
  salon: { label: 'Салон', cash: 150000, setup: 110000, fixed: 30000, sales: 60000, variable: 25, delay: 1, stress: 20 },
  workshop: { label: 'Майстерня', cash: 300000, setup: 250000, fixed: 45000, sales: 100000, variable: 45, delay: 0, stress: 30 },
};

export function calculateCashflow(input) {
  for (const key of ['cash', 'setup', 'fixed', 'sales']) {
    if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 100000000) {
      throw new RangeError('Суми мають бути від 0 до 100 000 000 грн.');
    }
  }
  for (const key of ['variable', 'stress']) {
    if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 100) {
      throw new RangeError('Частки мають бути від 0 до 100%.');
    }
  }
  if (!Number.isInteger(input.delay) || input.delay < 0 || input.delay > 6) {
    throw new RangeError('Затримка має бути цілим числом від 0 до 6 місяців.');
  }
  const cash = Math.round(input.cash * 100);
  const setup = Math.round(input.setup * 100);
  const fixed = Math.round(input.fixed * 100);
  function scenario(drop) {
    let balance = cash - setup;
    const rows = [{ month: 0, receipts: 0, payments: setup / 100, balance: balance / 100 }];
    for (let month = 1; month <= 6; month++) {
      const receipts = month <= input.delay ? 0 : Math.round(input.sales * 100 * (1 - drop / 100));
      const variable = Math.round(receipts * input.variable / 100);
      const payments = fixed + variable;
      balance += receipts - payments;
      rows.push({ month, receipts: receipts / 100, payments: payments / 100, balance: balance / 100 });
    }
    const minimum = Math.min(...rows.map(row => row.balance));
    return { rows, reserve: Math.max(0, -minimum), firstShortfall: rows.find(row => row.balance < 0)?.month ?? null };
  }
  return { base: scenario(0), stress: scenario(input.stress) };
}
