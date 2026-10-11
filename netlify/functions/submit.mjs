// Netlify Function: приймає заявку з форми та надсилає її в Telegram.
// Змінні оточення (Netlify → Site settings → Environment variables):
//   TG_BOT_TOKEN — токен бота від @BotFather
//   TG_CHAT_ID   — id чату/каналу для заявок
//
// Ендпоінт: /.netlify/functions/submit  (POST, JSON)

const escape = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Telegram відхиляє повідомлення довші за 4096 символів (sendMessage). Поля
// форми приходять з браузера без обмежень, тож довгий текст (або запит напряму
// через curl) інакше дав би 502, а справжній клієнт — «не вдалося надіслати».
// Обрізаємо за кодовими точками, щоб не розрізати емодзі навпіл.
const clip = (s, max) => Array.from(String(s ?? '')).slice(0, max).join('');

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  // Honeypot — тихо ігноруємо ботів (справжні заявки з цим полем не блокуємо жорстко)
  if (data.hp_gp_2026) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const { name = '', phone = '', messenger = '', idea = '', source = 'form', quiz = '', date = '', time = '' } = data;

  if (!name || !/^\+380\d{9}$/.test(phone)) {
    return { statusCode: 422, body: JSON.stringify({ ok: false, error: 'invalid' }) };
  }

  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

  const isBooking = Boolean(date && time);
  const lines = [
    isBooking ? '🗓️ <b>Запис на консультацію — ГрантПлан</b>' : '🟠 <b>Нова заявка — ГрантПлан</b>',
    date ? `📅 <b>Дата:</b> ${escape(clip(date, 60))}` : '',
    time ? `🕐 <b>Час:</b> ${escape(clip(time, 20))}` : '',
    `👤 <b>Ім’я:</b> ${escape(clip(name, 100))}`,
    `📞 <b>Телефон:</b> ${escape(phone)}`,
    messenger ? `💬 <b>Месенджер:</b> ${escape(clip(messenger, 40))}` : '',
    idea ? `💡 <b>Ідея:</b> ${escape(clip(idea, 1000))}` : '',
    quiz ? `🧮 <b>Квіз:</b> ${escape(clip(quiz, 1500))}` : '',
    `🔖 <b>Джерело:</b> ${escape(clip(source, 60))}`,
  ].filter(Boolean);

  const text = lines.join('\n');

  // Раніше тут повертався ok:true — користувач бачив «Заявку надіслано ✓»,
  // хоча заявка лишалась тільки в логах. Тепер це чесна помилка: фронтенд
  // покаже запасний шлях (Telegram / дзвінок), і лід не загубиться мовчки.
  if (!token || !chatId) {
    console.error('TG env not set — заявка не доставлена. Lead:', text);
    return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'not_configured' }) };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('Telegram error:', detail);
      return { statusCode: 502, body: JSON.stringify({ ok: false }) };
    }
    const delivery = await res.json();
    if (delivery?.ok !== true) return { statusCode: 502, body: JSON.stringify({ ok: false }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Send failed:', err);
    return { statusCode: 502, body: JSON.stringify({ ok: false }) };
  }
};

// --- FALLBACK: Formspree (розкоментуйте і приберіть Telegram-блок вище) ---
// export const handler = async (event) => {
//   const data = JSON.parse(event.body || '{}');
//   if (data.company) return { statusCode: 200, body: '{"ok":true}' };
//   const res = await fetch('https://formspree.io/f/XXXXXXX', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
//     body: JSON.stringify(data),
//   });
//   return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ ok: res.ok }) };
// };
