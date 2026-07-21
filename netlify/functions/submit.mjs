// Netlify Function: приймає заявку з форми та надсилає її в Telegram.
// Змінні оточення (Netlify → Site settings → Environment variables):
//   TG_BOT_TOKEN — токен бота від @BotFather
//   TG_CHAT_ID   — id чату/каналу для заявок
//
// Ендпоінт: /.netlify/functions/submit  (POST, JSON)

const escape = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  // Honeypot — тихо ігноруємо ботів
  if (data.company) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const { name = '', phone = '', messenger = '', idea = '', source = 'form', quiz = '' } = data;

  if (!name || !/^\+380\d{9}$/.test(phone)) {
    return { statusCode: 422, body: JSON.stringify({ ok: false, error: 'invalid' }) };
  }

  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

  const lines = [
    '🟠 <b>Нова заявка — ГрантПлан</b>',
    `👤 <b>Ім’я:</b> ${escape(name)}`,
    `📞 <b>Телефон:</b> ${escape(phone)}`,
    messenger ? `💬 <b>Месенджер:</b> ${escape(messenger)}` : '',
    idea ? `💡 <b>Ідея:</b> ${escape(idea)}` : '',
    quiz ? `🧮 <b>Квіз:</b> ${escape(quiz)}` : '',
    `🔖 <b>Джерело:</b> ${escape(source)}`,
  ].filter(Boolean);

  const text = lines.join('\n');

  if (!token || !chatId) {
    // Не налаштовано — не втрачаємо лід, лишаємо слід у логах.
    console.warn('TG env not set. Lead:', text);
    return { statusCode: 200, body: JSON.stringify({ ok: true, note: 'logged' }) };
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
