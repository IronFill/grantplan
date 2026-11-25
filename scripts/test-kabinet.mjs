// Тест кабінету передплатників: вхід за кодом, сесія, доступ і побудова розділів повної карточки.
// Мережі немає: fetch підмінюється, сховище підмінюється.
import assert from 'node:assert/strict';
import {
  readConfig, normalizeEmail, requestCode, verifyCode, ensureSession, sessionFresh,
  loadSession, saveSession, clearSession, fetchAccess, accessState, fetchFullCard, describeFull,
} from '../src/lib/kabinet.js';

const cfg = { url: 'https://abc.supabase.co', key: 'sb_publishable_test' };
const NOW = Date.parse('2026-11-25T10:00:00Z');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

// ---- налаштування
assert.equal(readConfig('', ''), null);
assert.equal(readConfig('http://abc.supabase.co', 'k'), null, 'лише https');
assert.equal(readConfig('https://abc.supabase.co/', 'k').url, 'https://abc.supabase.co');
assert.equal(readConfig('https://abc.supabase.co', ''), null);
assert.equal(readConfig('https://evil.com/path?x=1', 'k'), null, 'шлях і параметри в адресі не допускаються');

// ---- пошта
assert.equal(normalizeEmail('  Me@Example.COM '), 'me@example.com');
assert.equal(normalizeEmail('no-at'), null);
assert.equal(normalizeEmail('a b@c.com'), null);
assert.equal(normalizeEmail(null), null);

// ---- запит коду
let seen;
let r = await requestCode(cfg, ' A@B.com ', async (url, init) => { seen = { url, init }; return json(200, {}); });
assert.equal(r.ok, true); assert.equal(r.email, 'a@b.com');
assert.equal(seen.url, 'https://abc.supabase.co/auth/v1/otp');
assert.deepEqual(JSON.parse(seen.init.body), { email: 'a@b.com', create_user: false }, 'нових користувачів з сайту не створюємо');
assert.equal(seen.init.headers.apikey, cfg.key);
r = await requestCode(cfg, 'a@b.com', async () => json(422, { msg: 'Signups not allowed' }));
assert.equal(r.ok, true, 'відповідь однакова, чи є пошта в списку');
assert.equal((await requestCode(cfg, 'a@b.com', async () => json(429, {}))).reason, 'rate');
assert.equal((await requestCode(cfg, 'a@b.com', async () => json(503, {}))).reason, 'server');
assert.equal((await requestCode(cfg, 'a@b.com', async () => { throw new Error('offline'); })).reason, 'network');
assert.equal((await requestCode(cfg, 'bad', async () => assert.fail('не повинно йти в мережу'))).reason, 'email');

// ---- перевірка коду
r = await verifyCode(cfg, 'a@b.com', '123 456', async (url, init) => {
  assert.equal(url, 'https://abc.supabase.co/auth/v1/verify');
  assert.deepEqual(JSON.parse(init.body), { type: 'email', email: 'a@b.com', token: '123456' });
  return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { email: 'A@B.com' } });
}, NOW);
assert.equal(r.ok, true); assert.equal(r.access_token, 'AT'); assert.equal(r.email, 'a@b.com');
assert.equal(r.expires_at, Math.floor(NOW / 1000) + 3600);
assert.equal((await verifyCode(cfg, 'a@b.com', 'abc', async () => assert.fail('мережа'))).reason, 'format');
assert.equal((await verifyCode(cfg, 'a@b.com', '123456', async () => json(403, {}))).reason, 'code');
assert.equal((await verifyCode(cfg, 'a@b.com', '123456', async () => json(200, {}))).reason, 'server');

// ---- сесія й оновлення
const fresh = { access_token: 'AT', refresh_token: 'RT', expires_at: Math.floor(NOW / 1000) + 3600, email: 'a@b.com' };
assert.equal(sessionFresh(fresh, NOW), true);
assert.equal(sessionFresh({ ...fresh, expires_at: Math.floor(NOW / 1000) + 30 }, NOW), false, 'за хвилину до кінця вважаємо простроченою');
const store = memory();
assert.equal(saveSession(store, fresh), true);
assert.deepEqual(loadSession(store), fresh);
store.setItem('grantplan-kabinet-session', '{зламаний json');
assert.equal(loadSession(store), null);
assert.equal(loadSession({ getItem() { throw new Error('заборонено'); } }), null, 'недоступне сховище не ламає сторінку');
assert.equal(saveSession({ setItem() { throw new Error('quota'); } }, fresh), false);

let calls = 0;
const s2 = memory(); saveSession(s2, fresh);
assert.equal((await ensureSession(cfg, s2, async () => { calls++; return json(200, {}); }, NOW)).access_token, 'AT');
assert.equal(calls, 0, 'свіжу сесію не оновлюємо');
const old = { ...fresh, expires_at: Math.floor(NOW / 1000) - 10 };
const s3 = memory(); saveSession(s3, old);
const refreshed = await ensureSession(cfg, s3, async (url, init) => {
  assert.match(url, /grant_type=refresh_token$/); assert.equal(JSON.parse(init.body).refresh_token, 'RT');
  return json(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
}, NOW);
assert.equal(refreshed.access_token, 'AT2'); assert.equal(loadSession(s3).refresh_token, 'RT2');
const s4 = memory(); saveSession(s4, old);
assert.equal(await ensureSession(cfg, s4, async () => json(400, {}), NOW), null);
assert.equal(loadSession(s4), null, 'відкликана сесія очищається');
const s5 = memory(); saveSession(s5, old);
assert.equal(await ensureSession(cfg, s5, async () => { throw new Error('offline'); }, NOW), null);
assert.ok(loadSession(s5), 'без мережі сесію не стираємо');
clearSession(s5); assert.equal(loadSession(s5), null);

// ---- доступ і повна карточка
assert.equal(accessState(null, NOW), 'none');
assert.equal(accessState({ expires_at: null }, NOW), 'active');
assert.equal(accessState({ expires_at: '2026-12-01T00:00:00Z' }, NOW), 'active');
assert.equal(accessState({ expires_at: '2026-11-01T00:00:00Z' }, NOW), 'expired');
let req;
const row = await fetchAccess(cfg, fresh, async (url, init) => { req = { url, init }; return json(200, [{ email: 'a@b.com', expires_at: null }]); });
assert.equal(row.email, 'a@b.com');
assert.match(req.url, /access_grants\?select=email,plan,expires_at&email=eq\.a%40b\.com$/);
assert.equal(req.init.headers.Authorization, 'Bearer AT', 'запит іде з токеном користувача, не з ключем');
assert.equal(await fetchAccess(cfg, fresh, async () => json(401, {})), null);
assert.deepEqual(await fetchFullCard(cfg, fresh, 'p1', async () => json(200, [{ data: { term: 'x' } }])), { term: 'x' });
assert.equal(await fetchFullCard(cfg, fresh, 'p1', async () => json(200, [])), null, 'RLS повернув порожньо: даних немає');
assert.equal(await fetchFullCard(cfg, fresh, '../etc', async () => assert.fail('мережа')), null, 'id перевіряється до запиту');

// ---- розділи повної карточки
const full = {
  amount_bonuses: [{ percent: 20, condition: 'ветеран' }, { percent: 'x', condition: 'зламане' }],
  amount_note: 'Надбавки сумуються.',
  costs: { allowed: [{ item: 'обладнання', limit_percent: null }, { item: 'оренда', limit_percent: 25 }, { item: 'ремонт', limit_amount: 200000 }], forbidden: ['зарплата'] },
  cofinancing: { required: false, min_percent: null, note: null },
  obligations: ['Сплатити податки'], term: '5 років',
  eligibility_summary: 'Громадяни України', excluded_activities: ['зброя'], excluded_regions_note: null,
  period_note: 'Постійно', process: { how_to_apply: 'Через Дію', steps: ['Заява', 'Співбесіда'] },
  pitfalls: ['Рахунок'], tips: [], unverified: ['status'],
  sources: [{ title: 'Постанова', url: 'https://zakon.rada.gov.ua/x', checked: '2026-11-24' }, { title: 'Небезпечне', url: 'javascript:alert(1)', checked: '2026-11-24' }],
};
const sections = describeFull(full);
const by = Object.fromEntries(sections.map((s) => [s.title, s]));
assert.deepEqual(by['Надбавки до суми'].items, ['+20%: ветеран'], 'зламані надбавки відкидаються');
assert.deepEqual(by['На що можна витрачати'].items, ['обладнання', 'оренда, не більше 25% суми гранту', 'ремонт, не більше 200 000 грн']);
assert.equal(by['Власний внесок'].text, 'Власний внесок не вимагається.');
assert.deepEqual(by['Обов’язки й строки'].items, ['Сплатити податки', 'Строк: 5 років.']);
assert.deepEqual(by['Кроки'].items, ['Заява', 'Співбесіда']);
assert.equal(by['Поради з практики'], undefined, 'порожні розділи пропускаються');
assert.ok(by['Що ще звіряємо']);
assert.equal(by['Першоджерела'].items.length, 1, 'посилання не на https відкидається');
assert.equal(by['Першоджерела'].items[0].checkedLabel, '24 листопада 2026');
assert.deepEqual(describeFull(null), []);
assert.deepEqual(describeFull({}), []);

console.log('OK: кабінет передплатників (вхід, сесія, доступ, розділи карточки)');
