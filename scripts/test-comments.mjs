// Тест логіки модерації коментарів (functions/comments.js).
// Підміняє KV-сховище об'єктом у пам'яті — перевіряє саму логіку без wrangler.
// Запуск: node scripts/test-comments.mjs

import { onRequestGet, onRequestPost, onRequestDelete } from '../functions/comments.js';

const ADMIN_TOKEN = 'test-admin-token';

function makeKV() {
  const data = new Map();
  return {
    _data: data,
    async get(key, opts) {
      const raw = data.get(key);
      if (raw === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function ctx(kv, { method = 'GET', url = 'https://x/comments', body, admin = false, ip = '1.1.1.1' } = {}) {
  const headers = new Headers();
  if (admin) headers.set('x-admin-token', ADMIN_TOKEN);
  headers.set('CF-Connecting-IP', ip);
  return {
    request: new Request(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env: { COMMENTS_KV: kv, COMMENTS_ADMIN_TOKEN: ADMIN_TOKEN },
  };
}

const VALID = { name: 'Іван Петренко', business: 'СТО', email: 'ivan@example.com', text: 'Дуже корисна стаття, дякую.' };

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

console.log('Модерація коментарів:');

// 1. Новий коментар не з'являється публічно
{
  const kv = makeKV();
  const postRes = await onRequestPost(ctx(kv, { method: 'POST', body: VALID }));
  const posted = await postRes.json();
  check('POST приймає валідний коментар', postRes.status === 200 && posted.ok, `status=${postRes.status}`);
  check('POST не повертає коментар для миттєвого показу', posted.comment === undefined);
  check('POST позначає статус як pending', posted.status === 'pending');

  const getRes = await onRequestGet(ctx(kv));
  const listed = await getRes.json();
  check('Публічний GET не показує нeсхвалений коментар', listed.comments.length === 0, `отримано ${listed.comments.length}`);
}

// 2. Схвалення публікує коментар і ховає email
{
  const kv = makeKV();
  await onRequestPost(ctx(kv, { method: 'POST', body: VALID }));
  const pendingKey = [...kv._data.keys()].find((k) => k.startsWith('pending:'));
  const id = pendingKey.slice('pending:'.length);

  const denied = await onRequestPost(ctx(kv, { method: 'POST', url: `https://x/comments?action=approve&id=${id}` }));
  check('Схвалення без токена — 403', denied.status === 403, `status=${denied.status}`);

  const ok = await onRequestPost(ctx(kv, { method: 'POST', url: `https://x/comments?action=approve&id=${id}`, admin: true }));
  check('Схвалення з токеном — 200', ok.status === 200, `status=${ok.status}`);

  const listed = await (await onRequestGet(ctx(kv))).json();
  check('Схвалений коментар з\'явився публічно', listed.comments.length === 1);
  check('Email не потрапляє у публічну видачу', listed.comments[0]?.email === undefined);
  check('Черга модерації спорожніла', [...kv._data.keys()].every((k) => !k.startsWith('pending:')));
}

// 3. Черга модерації закрита для сторонніх
{
  const kv = makeKV();
  await onRequestPost(ctx(kv, { method: 'POST', body: VALID }));

  const denied = await onRequestGet(ctx(kv, { url: 'https://x/comments?pending=1' }));
  check('Черга модерації без токена — 403', denied.status === 403, `status=${denied.status}`);

  const allowed = await onRequestGet(ctx(kv, { url: 'https://x/comments?pending=1', admin: true }));
  const queue = await allowed.json();
  check('Адмін бачить чергу модерації', allowed.status === 200 && queue.pending.length === 1);
}

// 4. Одночасні коментарі не затирають один одного (колишній race у `list`)
{
  const kv = makeKV();
  await Promise.all([
    onRequestPost(ctx(kv, { method: 'POST', body: VALID, ip: '1.1.1.1' })),
    onRequestPost(ctx(kv, { method: 'POST', body: { ...VALID, name: 'Олена Коваль' }, ip: '2.2.2.2' })),
    onRequestPost(ctx(kv, { method: 'POST', body: { ...VALID, name: 'Петро Сидор' }, ip: '3.3.3.3' })),
  ]);
  const pending = [...kv._data.keys()].filter((k) => k.startsWith('pending:'));
  check('Три одночасні коментарі збереглись усі', pending.length === 3, `збережено ${pending.length}`);
}

// 5. Валідація
{
  const kv = makeKV();
  const bad = [
    ['коротке ім\'я без прізвища', { ...VALID, name: 'Іван' }, 422],
    ['некоректний email', { ...VALID, email: 'not-an-email' }, 422],
    ['закороткий текст', { ...VALID, text: 'ок' }, 422],
  ];
  for (const [label, body, expected] of bad) {
    const res = await onRequestPost(ctx(kv, { method: 'POST', body }));
    check(`Відхиляє: ${label}`, res.status === expected, `status=${res.status}`);
  }

  const hp = await onRequestPost(ctx(kv, { method: 'POST', body: { ...VALID, hp_gp_comment: 'bot' } }));
  check('Honeypot тихо ігнорується', hp.status === 200);
  check('Honeypot нічого не зберігає', [...kv._data.keys()].every((k) => !k.startsWith('pending:')));
}

// 6. Rate limiting
{
  const kv = makeKV();
  const results = [];
  for (let i = 0; i < 5; i++) {
    const res = await onRequestPost(ctx(kv, { method: 'POST', body: VALID, ip: '9.9.9.9' }));
    results.push(res.status);
  }
  check('Ліміт спрацьовує після 3 коментарів з однієї IP', results.slice(3).every((s) => s === 429), `статуси: ${results.join(',')}`);

  const other = await onRequestPost(ctx(kv, { method: 'POST', body: VALID, ip: '8.8.8.8' }));
  check('Інша IP не заблокована', other.status === 200, `status=${other.status}`);
}

// 7. Видалення
{
  const kv = makeKV();
  await onRequestPost(ctx(kv, { method: 'POST', body: VALID }));
  const id = [...kv._data.keys()].find((k) => k.startsWith('pending:')).slice('pending:'.length);
  await onRequestPost(ctx(kv, { method: 'POST', url: `https://x/comments?action=approve&id=${id}`, admin: true }));

  const denied = await onRequestDelete(ctx(kv, { method: 'DELETE', url: `https://x/comments?id=${id}` }));
  check('Видалення без токена — 403', denied.status === 403, `status=${denied.status}`);

  const ok = await onRequestDelete(ctx(kv, { method: 'DELETE', url: `https://x/comments?id=${id}`, admin: true }));
  check('Видалення з токеном — 200', ok.status === 200);

  const listed = await (await onRequestGet(ctx(kv))).json();
  check('Видалений коментар зник з публічної видачі', listed.comments.length === 0);
}

// 8. Сумісність зі старими даними (коментарі, опубліковані до модерації)
{
  const kv = makeKV();
  await kv.put('list', JSON.stringify([{ id: 'old-1', name: 'Стара Публікація', business: '', email: 'a@b.co', text: 'Опубліковано до введення модерації', createdAt: '2026-01-01T00:00:00.000Z' }]));
  const listed = await (await onRequestGet(ctx(kv))).json();
  check('Раніше опубліковані коментарі лишаються видимими', listed.comments.length === 1);
  check('Email старих коментарів теж прихований', listed.comments[0]?.email === undefined);
}

console.log(failures ? `\n✗ Провалено перевірок: ${failures}` : '\n✓ Усі перевірки пройдено');
process.exit(failures ? 1 : 0);
