// Cloudflare Pages Function: приймає заявку з форми та надсилає її в Telegram.
// Змінні оточення (Cloudflare Pages → Settings → Environment variables):
//   TG_BOT_TOKEN — токен бота від @BotFather
//   TG_CHAT_ID   — id чату/каналу для заявок
//
// Ендпоінт: /submit  (POST, JSON)

const escape = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  // Honeypot — тихо ігноруємо ботів
  if (data.company) {
    return Response.json({ ok: true });
  }

  const { name = '', phone = '', messenger = '', idea = '', source = 'form', quiz = '', date = '', time = '' } = data;

  if (!name || !/^\+380\d{9}$/.test(phone)) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 422 });
  }

  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;

  const isBooking = source === 'booking';
  const lines = [
    isBooking ? '🗓️ <b>Запис на консультацію — ГрантПлан</b>' : '🟠 <b>Нова заявка — ГрантПлан</b>',
    date ? `📅 <b>Дата:</b> ${escape(date)}` : '',
    time ? `🕐 <b>Час:</b> ${escape(time)}` : '',
    `👤 <b>Ім’я:</b> ${escape(name)}`,
    `📞 <b>Телефон:</b> ${escape(phone)}`,
    messenger ? `💬 <b>Месенджер:</b> ${escape(messenger)}` : '',
    idea ? `💡 <b>Ідея:</b> ${escape(idea)}` : '',
    quiz ? `🧮 <b>Квіз:</b> ${escape(quiz)}` : '',
    `🔖 <b>Джерело:</b> ${escape(source)}`,
  ].filter(Boolean);

  const text = lines.join('\n');

  if (!token || !chatId) {
    console.warn('TG env not set. Lead:', text);
    return Response.json({ ok: true, note: 'logged' });
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
      return Response.json({ ok: false }, { status: 502 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error('Send failed:', err);
    return Response.json({ ok: false }, { status: 502 });
  }
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405 });
}
