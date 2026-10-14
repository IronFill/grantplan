import assert from 'node:assert/strict';
import { deliverLead, leadMessage } from '../src/lib/lead-delivery.js';
import { kyivClock, minimumBookingDate, validBooking } from '../src/lib/booking-clock.js';
import { validateLead } from '../src/lib/lead-validation.js';
import { pruneLeads } from '../src/lib/lead-retention.js';

const original = globalThis.fetch;
const values = { name: 'ТЕСТ <name>', phone: '+380501234567', source: 'test' };
const requestId = '12345678-1234-4123-8123-123456789abc';
const options = { token: 'test', chatId: 'test', requestId, values, text: leadMessage(values) };
const memory = () => {
  const data = new Map();
  return { data, get: async key => data.get(key) || null, put: async (key, value) => data.set(key, value) };
};
let calls = 0;
try {
  const store = memory();
  globalThis.fetch = async () => {
    calls++;
    assert.equal(JSON.parse(store.data.get(`lead:${requestId}`)).state, 'sending');
    return Response.json({ ok: true });
  };
  assert.equal((await deliverLead({ ...options, store })).body.ok, true);
  assert.equal((await deliverLead({ ...options, store })).body.duplicate, true);
  assert.equal(calls, 1, 'A confirmed repeat must not send again');
  assert.equal((await deliverLead({ ...options, store, values: { ...values, name: 'changed' } })).status, 409);
  assert.equal(calls, 1);

  globalThis.fetch = async () => { calls++; throw new Error('network'); };
  const uncertain = memory();
  assert.equal((await deliverLead({ ...options, store: uncertain })).body.saved, true);
  assert.equal(JSON.parse(uncertain.data.get(`lead:${requestId}`)).state, 'uncertain');
  assert.equal((await deliverLead({ ...options, store: uncertain })).status, 409);
  assert.equal(calls, 2, 'Unknown delivery must not be blindly retried');

  const failed = memory();
  globalThis.fetch = async () => { calls++; return Response.json({ ok: false }, { status: 400 }); };
  await deliverLead({ ...options, store: failed });
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true }); };
  assert.equal((await deliverLead({ ...options, store: failed })).body.ok, true);
  assert.equal(calls, 4, 'Explicit rejection may be retried');

  const broken = { get: async () => null, put: async () => { throw new Error('store'); } };
  assert.equal((await deliverLead({ ...options, store: broken })).status, 503);
  assert.equal(calls, 4, 'No delivery before durable write');
  assert.equal((await deliverLead({ ...options, token: '' })).status, 503);
  assert.ok(options.text.includes('&lt;name&gt;'));
  assert.equal(validateLead(values).ok, false, 'Server requires consent');
  assert.equal(validateLead({ ...values, consent: 'on', requestId }).ok, true);
  assert.equal(validateLead({ ...values, consent: 'on' }).ok, false, 'Request identity is mandatory');
  for (const id of [undefined, requestId]) {
    const rejected = validateLead({ ...values, consent: 'on', requestId: id, date: '99.99.9999', time: '03:00' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.field, 'date', 'Calendar validation cannot depend on request identity');
  }
  assert.equal(validBooking('31.02.2026', '10:00'), false);
  const noon = new Date('2026-10-14T09:00:00Z');
  assert.equal(validBooking('14.10.2026', '17:00', noon), false, 'Same-day booking rejected even before slot');
  assert.equal(validBooking('13.10.2026', '10:00', noon), false, 'Past date rejected');
  assert.equal(validBooking('15.10.2026', '10:00', noon), true, 'Tomorrow available');
  assert.equal(validBooking('', '', noon), true, 'Undated callback preserved');
  assert.equal(validBooking('18.10.2026', '10:00', noon), false, 'Sunday remains unavailable');
  assert.equal(minimumBookingDate(new Date('2026-10-31T12:00:00Z')).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(minimumBookingDate(new Date('2026-12-31T12:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
  const afterKyivMidnight = new Date('2026-07-15T21:05:00Z');
  assert.equal(validBooking('16.07.2026', '17:00', afterKyivMidnight), false, 'Kyiv day16 is already today while UTC day15');
  assert.equal(validBooking('17.07.2026', '10:00', afterKyivMidnight), true);
  const beforeMidnight = new Date('2026-07-15T20:59:00Z');
  assert.equal(validBooking('16.07.2026', '10:00', beforeMidnight), true);
  assert.equal(validBooking('16.07.2026', '10:00', afterKyivMidnight), false, 'Open form becomes stale at midnight');
  assert.equal(validBooking('12.10.2026 (понеділок)', '10:00', new Date('2026-10-11T09:00:00Z')), true);
  assert.equal(validBooking('12.10.2026', '18:00'), false);
  assert.equal(kyivClock(new Date('2026-01-15T08:00:00Z')).getUTCHours(), 10);
  assert.equal(kyivClock(new Date('2026-07-15T07:00:00Z')).getUTCHours(), 10);
  assert.equal(kyivClock(new Date('2026-07-15T22:00:00Z')).getUTCDate(), 16);

  const records = new Map([
    ['lead:old', { createdAt: '2026-08-01T00:00:00Z' }],
    ['lead:new', { createdAt: '2026-10-10T00:00:00Z' }],
    ['rate:expired', { until: 0 }], ['other:key', {}],
  ]);
  const retention = {
    async *list() { yield { blobs: [...records.keys()].map(key => ({ key })) }; },
    get: async key => records.get(key), delete: async key => records.delete(key),
  };
  assert.equal(await pruneLeads(retention, Date.parse('2026-10-11T00:00:00Z')), 2);
  assert.ok(records.has('lead:new') && records.has('other:key'));
  console.log('Lead delivery, consent, Kyiv calendar and retention checks passed');
} finally { globalThis.fetch = original; }
