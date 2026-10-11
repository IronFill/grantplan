// Граничні тести явної серверної валідації заявки.
// Той самий набір перевірок проганяється через ОБИДВА обробники:
//   functions/submit.js            — Cloudflare Pages (прод)
//   netlify/functions/submit.mjs   — Netlify (запасний хостинг)
// Telegram і KV підмінюються заглушками; мережі немає.
// Запуск: node scripts/test-lead-limits.mjs

import fs from 'node:fs';
import { onRequestPost } from '../functions/submit.js';
import { handler as netlifyHandler } from '../netlify/functions/submit.mjs';
import { LEAD_LIMITS, TELEGRAM_TEXT_LIMIT, charLength, telegramVisibleLength, validateLead, validateTelegramText } from '../src/lib/lead-validation.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const VALID = { consent: 'on', name: 'Іван Петренко', phone: '+380501234567', messenger: 'Telegram' };

// --- Заглушки -----------------------------------------------------------------
let telegram = [];
globalThis.fetch = async (url, init) => {
  telegram.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
process.env.TG_BOT_TOKEN = 'token';
process.env.TG_CHAT_ID = '123';

function makeKV() {
  const data = new Map();
  return { _data: data, async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); } };
}

// Однаковий інтерфейс для обох обробників: send(body, opts) → { status, json }
const runners = {
  'Cloudflare (functions/submit.js)': async (body, { env = { TG_BOT_TOKEN: 'token', TG_CHAT_ID: '123' }, ip = '1.1.1.1', raw } = {}) => {
    const headers = new Headers({ 'CF-Connecting-IP': ip });
    const res = await onRequestPost({
      request: new Request('https://x/submit', { method: 'POST', headers, body: raw ?? JSON.stringify(body) }),
      env,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: res.status, json };
  },
  'Netlify (netlify/functions/submit.mjs)': async (body, { env, raw } = {}) => {
    const saved = { t: process.env.TG_BOT_TOKEN, c: process.env.TG_CHAT_ID };
    if (env && !env.TG_BOT_TOKEN) { delete process.env.TG_BOT_TOKEN; delete process.env.TG_CHAT_ID; }
    try {
      const res = await netlifyHandler({ httpMethod: 'POST', body: raw ?? JSON.stringify(body) });
      let json = null;
      try { json = JSON.parse(res.body); } catch { /* не JSON */ }
      return { status: res.statusCode, json };
    } finally {
      process.env.TG_BOT_TOKEN = saved.t;
      process.env.TG_CHAT_ID = saved.c;
    }
  },
};

const lastText = () => telegram.at(-1)?.body.text ?? '';

for (const [runnerName, send] of Object.entries(runners)) {
  console.log(`\n${runnerName}:`);

  // 1. Кожне поле: рівно на межі — приймається й доходить повністю; на 1 більше — 422
  for (const [field, max] of Object.entries(LEAD_LIMITS)) {
    const ch = field === 'name' ? 'І' : 'я';
    telegram = [];
    let res = await send({ ...VALID, [field]: ch.repeat(max) });
    check(`${field}: рівно ${max} символів приймається`, res.status === 200 && res.json?.ok === true, `status=${res.status}`);
    check(`${field}: значення дійшло до Telegram повністю (нічого не обрізано)`, lastText().includes(ch.repeat(max)) && !lastText().includes(ch.repeat(max + 1)));

    telegram = [];
    res = await send({ ...VALID, [field]: ch.repeat(max + 1) });
    check(`${field}: ${max + 1} символів → 422 too_long`, res.status === 422 && res.json?.error === 'too_long' && res.json?.field === field && res.json?.max === max && res.json?.length === max + 1, JSON.stringify(res));
    check(`${field}: у відповіді зрозуміле повідомлення`, typeof res.json?.message === 'string' && res.json.message.includes('максимум') && res.json.message.includes(String(max)));
    check(`${field}: у Telegram нічого не пішло`, telegram.length === 0);
  }

  // 2. Емодзі: довжина — в одиницях UTF-16, як у maxlength браузера (емодзі = 2 одиниці)
  {
    telegram = [];
    const emoji500 = '😀'.repeat(LEAD_LIMITS.idea / 2);
    let res = await send({ ...VALID, idea: emoji500 });
    check('500 емодзі (рівно 1000 одиниць UTF-16) приймаються і доходять повністю', res.status === 200 && lastText().includes(emoji500), `status=${res.status}`);
    telegram = [];
    res = await send({ ...VALID, idea: '😀'.repeat(LEAD_LIMITS.idea / 2 + 1) });
    check('501 емодзі (1002 одиниці) → 422 too_long, length=1002', res.status === 422 && res.json?.error === 'too_long' && res.json?.length === 1002 && telegram.length === 0, JSON.stringify(res.json));
    // Паритет із браузером: усе, що maxlength пропускає, сервер приймає
    check('довжина рахується тими самими одиницями, що й maxlength', charLength('😀') === '😀'.length && charLength('😀') === 2);
  }

  // 3. Усі поля на межі разом — вкладається в Telegram
  {
    telegram = [];
    const all = { consent: 'on', name: 'І'.repeat(100), phone: VALID.phone, messenger: 'я'.repeat(40), idea: 'я'.repeat(1000), source: 'я'.repeat(40), quiz: 'я'.repeat(1500), date: 'я'.repeat(60), time: 'я'.repeat(20) };
    const res = await send(all);
    check('усі поля на межі одночасно: приймається', res.status === 200, `status=${res.status}`);
    check(`видима довжина повідомлення ≤ ${TELEGRAM_TEXT_LIMIT}`, telegramVisibleLength(lastText()) <= TELEGRAM_TEXT_LIMIT, `довжина=${telegramVisibleLength(lastText())}`);
  }

  // 4. Символи розмітки: Telegram рахує текст ПІСЛЯ розбору, тож &amp; — це один символ
  {
    telegram = [];
    const amp = { ...VALID, idea: '&'.repeat(1000), quiz: '&'.repeat(1500), name: '&'.repeat(100) };
    const res = await send(amp);
    check('1000×«&» + 1500×«&» + 100×«&» приймається (екранування не рахується в ліміт Telegram)', res.status === 200 && res.json?.ok === true, JSON.stringify(res));
    check('у Telegram іде екранований текст', lastText().includes('&amp;'.repeat(100)) && telegramVisibleLength(lastText()) <= TELEGRAM_TEXT_LIMIT);
    const lt = await send({ ...VALID, idea: '<b>ідея</b> & <i>x</i>' });
    check('теги в тексті ідеї екрануються, а не виконуються', lt.status === 200 && lastText().includes('&lt;b&gt;ідея&lt;/b&gt;') && !lastText().includes('<i>x</i>'));
  }

  // 4.1. Усі поля з емодзі на межах одночасно (у UTF-16) вкладаються в Telegram
  {
    telegram = [];
    const emojiAll = { ...VALID, name: '😀'.repeat(50), messenger: '😀'.repeat(20), idea: '😀'.repeat(500), source: '😀'.repeat(20), quiz: '😀'.repeat(750), date: '😀'.repeat(30), time: '😀'.repeat(10) };
    const res = await send(emojiAll);
    check('усі поля з емодзі на межах разом приймаються', res.status === 200 && telegramVisibleLength(lastText()) <= TELEGRAM_TEXT_LIMIT, `status=${res.status} довжина=${telegramVisibleLength(lastText())}`);
    check('Telegram отримує parse_mode=HTML', telegram.at(-1)?.body.parse_mode === 'HTML');
  }

  // 5. Типи та обов'язкові поля
  {
    const cases = [
      ['name — об’єкт', { ...VALID, name: {} }, 'name'],
      ['idea — число', { ...VALID, idea: 123 }, 'idea'],
      ['quiz — масив', { ...VALID, quiz: ['a'] }, 'quiz'],
      ['порожнє ім’я', { ...VALID, name: '   ' }, 'name'],
      ['телефон без +380', { ...VALID, phone: '0501234567' }, 'phone'],
    ];
    for (const [label, body, field] of cases) {
      telegram = [];
      const res = await send(body);
      check(`${label} → 422 invalid (${field})`, res.status === 422 && res.json?.error === 'invalid' && res.json?.field === field && telegram.length === 0, JSON.stringify(res));
    }
    for (const [label, raw] of [['JSON null', 'null'], ['JSON масив', '[]'], ['JSON рядок', '"x"']]) {
      const res = await send(null, { raw });
      check(`${label} → 422, без падіння`, res.status === 422 && res.json?.ok === false, `status=${res.status}`);
    }
    const bad = await send(null, { raw: '{oops' });
    check('некоректний JSON → 400', bad.status === 400, `status=${bad.status}`);
  }

  // 6. Honeypot: бот отримує ok:true навіть із сміттям у полях і нічого не надсилається
  {
    telegram = [];
    const res = await send({ hp_gp_2026: 'bot', name: {}, idea: 'я'.repeat(5000) });
    check('honeypot → 200 ok:true, нічого не надсилається', res.status === 200 && res.json?.ok === true && telegram.length === 0);
  }

  // 7. Валідація йде ДО перевірки налаштувань Telegram
  {
    telegram = [];
    const res = await send({ ...VALID, idea: 'я'.repeat(1001) }, { env: {} });
    check('без TG env надто довге поле → 422, а не 503', res.status === 422, `status=${res.status}`);
    const ok = await send(VALID, { env: {} });
    check('без TG env коректна заявка → 503 not_configured', ok.status === 503 && ok.json?.error === 'not_configured', `status=${ok.status}`);
  }

  // 8. Повторна відправка після виправлення проходить
  {
    telegram = [];
    const long = await send({ ...VALID, idea: 'я'.repeat(1001) });
    const fixed = await send({ ...VALID, idea: 'я'.repeat(1000) });
    check('після скорочення тексту та сама заявка приймається', long.status === 422 && fixed.status === 200 && telegram.length === 1);
  }
}

// --- Лише Cloudflare: валідація ДО ліміту за IP -----------------------------------
console.log('\nCloudflare: порядок «валідація → ліміт → Telegram»');
{
  const send = runners['Cloudflare (functions/submit.js)'];
  const kv = makeKV();
  const env = { TG_BOT_TOKEN: 'token', TG_CHAT_ID: '123', COMMENTS_KV: kv };
  telegram = [];
  const rejected = [];
  for (let i = 0; i < 8; i++) rejected.push((await send({ ...VALID, idea: 'я'.repeat(1001) }, { env, ip: '7.7.7.7' })).status);
  check('8 відхилених заявок поспіль — усі 422 (не 429)', rejected.every((s) => s === 422), rejected.join(','));
  check('відхилені заявки не списують квоту IP (KV порожній)', kv._data.size === 0, `ключів=${kv._data.size}`);
  const accepted = [];
  for (let i = 0; i < 5; i++) accepted.push((await send(VALID, { env, ip: '7.7.7.7' })).status);
  check('після відхилень усі 5 валідних заявок проходять', accepted.every((s) => s === 200), accepted.join(','));
  check('6-та валідна заявка з тієї ж IP → 429', (await send(VALID, { env, ip: '7.7.7.7' })).status === 429);
}

// --- Паритет двох обробників -------------------------------------------------------
console.log('\nПаритет обробників (однакові відповіді на однакові входи):');
{
  const inputs = [
    VALID,
    { ...VALID, idea: 'я'.repeat(1001) },
    { ...VALID, name: '' },
    { ...VALID, idea: '&'.repeat(1000), quiz: '&'.repeat(1500), name: '&'.repeat(100) },
    { ...VALID, idea: '😀'.repeat(1000), quiz: '😀'.repeat(1500), name: '😀'.repeat(100) },
    { ...VALID, quiz: 5 },
  ];
  const [cf, nl] = Object.values(runners);
  let same = true;
  for (const input of inputs) {
    telegram = [];
    const a = await cf(input);
    const b = await nl(input);
    if (a.status !== b.status || JSON.stringify(a.json) !== JSON.stringify(b.json)) {
      same = false;
      console.error('    розбіжність:', JSON.stringify(input).slice(0, 80), a, b);
    }
  }
  check('Cloudflare і Netlify відповідають однаково на 6 різних входів', same);
}

// --- Реальний максимум квізу -------------------------------------------------------
console.log('\nКвіз: реальний максимум прихованого поля проти ліміту:');
{
  const src = fs.readFileSync(new URL('../src/components/Quiz.astro', import.meta.url), 'utf8');
  const blockersSrc = src.slice(src.indexOf('const hardBlockers'));
  const blockers = [...blockersSrc.slice(0, blockersSrc.indexOf('];')).matchAll(/label:\s*'([^']*)'/g)].map((m) => m[1]);
  const qSrc = src.slice(src.indexOf('const questions'), src.indexOf('const bonusGrounds'));
  const options = {};
  for (const m of qSrc.matchAll(/key:\s*'(\w+)',\s*options:\s*\[([^\]]*)\]/g)) {
    options[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  }
  check('з Quiz.astro розібрано блокуючі умови (≥7) і 5 питань', blockers.length >= 7 && Object.keys(options).length === 5, `blockers=${blockers.length}, questions=${Object.keys(options).length}`);

  const longest = Object.fromEntries(Object.entries(options).map(([k, v]) => [k, [...v].sort((a, b) => charLength(b) - charLength(a))[0]]));
  // Найдовший результат — гілка «блокуючі умови» з усіма позначеними пунктами (див. finish()).
  const blockedResult = 'РЕЗУЛЬТАТ: блокуючі умови — ' + blockers.join('; ');
  const successResult = 'РЕЗУЛЬТАТ: масштабування діючої справи, 500 000 – 1 500 000 ₴, надбавки +125% → до 2 500 000 ₴';
  const maxQuiz = Math.max(...[blockedResult, successResult].map((result) => charLength(JSON.stringify({ ...longest, result }))));
  console.log(`    найдовший штатний payload квізу: ${maxQuiz} символів; ліміт: ${LEAD_LIMITS.quiz}`);
  check('штатний квіз у найгіршому випадку вкладається в ліміт', maxQuiz <= LEAD_LIMITS.quiz, `${maxQuiz} > ${LEAD_LIMITS.quiz}`);

  telegram = [];
  const res = await runners['Cloudflare (functions/submit.js)']({ ...VALID, source: 'quiz', quiz: JSON.stringify({ ...longest, result: blockedResult }) });
  check('найдовший штатний payload квізу реально приймається сервером', res.status === 200 && res.json?.ok === true, JSON.stringify(res));
}

// --- Telegram-ліміт: страховка рахує так, як Telegram (після розбору розмітки) ---------
console.log('\nПідрахунок видимої довжини для Telegram:');
{
  const escapeLikeHandlers = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tricky = ['&lt;b&gt;', '&amp;lt;', '&quot; &#39; &nbsp;', '<B>x</B> <b >y', '<<>>&&', '&amp;amp;amp;', 'a&b<c>d', '😀&😀<😀>', '\n&\n'];
  const mismatches = tricky.filter((t) => telegramVisibleLength(`<b>X</b> ${escapeLikeHandlers(t)}`) !== 'X '.length + t.length);
  check('видима довжина = довжина вихідного тексту для «складних» рядків (&lt;, &amp;lt;, <B>, емодзі…)', mismatches.length === 0, JSON.stringify(mismatches));
  check('4096 видимих символів проходить, 4097 — ні', validateTelegramText('я'.repeat(4096)).ok && !validateTelegramText('я'.repeat(4097)).ok);
  const big = validateTelegramText('я'.repeat(4097));
  check('завелике повідомлення → 422 scope=message з поясненням', big.status === 422 && big.scope === 'message' && /скоротіть/.test(big.message));
  check('теги й сутності не входять у ліміт Telegram', validateTelegramText('<b>' + '&amp;'.repeat(4096) + '</b>').ok && !validateTelegramText('<b>' + '&amp;'.repeat(4097) + '</b>').ok);
  const sumOfLimits = Object.values(LEAD_LIMITS).reduce((a, b) => a + b, 0);
  check(`сума лімітів полів (${sumOfLimits}) + службові рядки вкладається в ${TELEGRAM_TEXT_LIMIT}`, sumOfLimits + 400 <= TELEGRAM_TEXT_LIMIT, `сума=${sumOfLimits}`);
}

// --- Модуль окремо -----------------------------------------------------------------
console.log('\nМодуль lead-validation:');
{
  check('валідна заявка: значення повертаються, source за замовчуванням «form»', validateLead(VALID).ok && validateLead(VALID).values.source === 'form');
  check('LEAD_LIMITS заморожено', Object.isFrozen(LEAD_LIMITS));
}

console.log(failures ? `\n✗ Провалено перевірок: ${failures}` : '\n✓ Усі перевірки пройдено');
process.exit(failures ? 1 : 0);
