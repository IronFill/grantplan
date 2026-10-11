// Тест логіки прийому заявок (functions/submit.js).
// Підміняє Telegram API та KV — перевіряє логіку без мережі й wrangler.
// Запуск: node scripts/test-submit.mjs

import { onRequestPost } from '../functions/submit.js';

function makeKV() {
  const data = new Map();
  return {
    _data: data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
}

function ctx(env, { body, ip = '1.1.1.1' } = {}) {
  const headers = new Headers();
  headers.set('CF-Connecting-IP', ip);
  return {
    request: new Request('https://x/submit', { method: 'POST', headers, body: JSON.stringify(body) }),
    env,
  };
}

const VALID = { name: 'Іван Петренко', phone: '+380501234567', messenger: 'Telegram' };
const CONFIGURED = { TG_BOT_TOKEN: 'token', TG_CHAT_ID: '123' };

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

// Перехоплюємо мережу: жоден тест не повинен реально стукати в Telegram.
const realFetch = globalThis.fetch;
let sentMessages = [];
globalThis.fetch = async (url, init) => {
  sentMessages.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

console.log('Прийом заявок:');

// 1. Головний фікс: недоналаштований Telegram більше не вдає успіх
{
  sentMessages = [];
  const res = await onRequestPost(ctx({}, { body: VALID }));
  const data = await res.json();
  check('Без TG env повертає помилку, а не ok:true', res.status === 503 && data.ok === false, `status=${res.status} ok=${data.ok}`);
  check('Без TG env нічого не надсилається', sentMessages.length === 0);
}

// 2. Нормальний шлях
{
  sentMessages = [];
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  const data = await res.json();
  check('Валідна заявка приймається', res.status === 200 && data.ok === true, `status=${res.status}`);
  check('Заявка йде в Telegram', sentMessages.length === 1 && sentMessages[0].url.includes('sendMessage'));
  check('Повідомлення містить ім\'я та телефон',
    sentMessages[0]?.body.text.includes('Іван Петренко') && sentMessages[0]?.body.text.includes('+380501234567'));
}

// 3. Валідація телефону
{
  const bad = [
    ['порожнє ім\'я', { ...VALID, name: '' }],
    ['телефон без +380', { ...VALID, phone: '0501234567' }],
    ['закороткий телефон', { ...VALID, phone: '+38050123' }],
    ['телефон з літерами', { ...VALID, phone: '+380abcdefghi' }],
  ];
  for (const [label, body] of bad) {
    const res = await onRequestPost(ctx(CONFIGURED, { body }));
    check(`Відхиляє: ${label}`, res.status === 422, `status=${res.status}`);
  }
}

// 4. Honeypot
{
  sentMessages = [];
  const res = await onRequestPost(ctx(CONFIGURED, { body: { ...VALID, hp_gp_2026: 'bot' } }));
  check('Honeypot повертає 200 (бот не бачить різниці)', res.status === 200);
  check('Honeypot нічого не надсилає', sentMessages.length === 0);
}

// 5. Rate limiting
{
  const kv = makeKV();
  const env = { ...CONFIGURED, COMMENTS_KV: kv };
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const res = await onRequestPost(ctx(env, { body: VALID, ip: '9.9.9.9' }));
    statuses.push(res.status);
  }
  check('Ліміт спрацьовує після 5 заявок з однієї IP', statuses.slice(5).every((s) => s === 429), `статуси: ${statuses.join(',')}`);

  const other = await onRequestPost(ctx(env, { body: VALID, ip: '8.8.8.8' }));
  check('Інша IP не заблокована', other.status === 200, `status=${other.status}`);
}

// 6. Без KV ліміт не ламає форму
{
  sentMessages = [];
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  check('Без прив\'язаного KV форма працює далі', res.status === 200, `status=${res.status}`);
}

// 6.1. Надто довгі поля не ламають доставку (ліміт Telegram — 4096 символів)
{
  sentMessages = [];
  const long = 'я'.repeat(6000);
  const res = await onRequestPost(ctx(CONFIGURED, { body: { ...VALID, name: 'І'.repeat(500), idea: long, quiz: long, source: long, date: long, time: long, messenger: long } }));
  const text = sentMessages[0]?.body.text ?? '';
  check('Довгі поля: заявка все одно приймається', res.status === 200, `status=${res.status}`);
  check('Довгі поля: повідомлення вкладається в 4096 символів', text.length > 0 && Array.from(text).length <= 4096, `довжина=${Array.from(text).length}`);
  check('Довгі поля: ім\'я обрізано до 100 символів', !text.includes('І'.repeat(101)) && text.includes('І'.repeat(100)));
  check('Довгі поля: телефон лишився повним', text.includes('+380501234567'));
}

// 7. Помилка Telegram не видається за успіх
{
  globalThis.fetch = async () => new Response('Bad Request', { status: 400 });
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  const data = await res.json();
  check('Збій Telegram повертає помилку', res.status === 502 && data.ok === false, `status=${res.status}`);
}

for (const body of ['{"ok":false}', '{}', 'not JSON']) {
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  check('Reject unconfirmed delivery: ' + body, res.status === 502 && (await res.json()).ok === false);
}
globalThis.fetch = realFetch;

console.log(failures ? `\n✗ Провалено перевірок: ${failures}` : '\n✓ Усі перевірки пройдено');
process.exit(failures ? 1 : 0);
