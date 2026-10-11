// Cloudflare Pages Function: приймає заявку з форми та надсилає її в Telegram.
// Змінні оточення (Cloudflare Pages → Settings → Environment variables):
//   TG_BOT_TOKEN — токен бота від @BotFather
//   TG_CHAT_ID   — id чату/каналу для заявок
//
// Ендпоінт: /submit  (POST, JSON)

import { validateLead, validateTelegramText } from '../src/lib/lead-validation.js';

const escape = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Відповідь на відхилену заявку: лише безпечні поля, без внутрішніх деталей.
const rejection = ({ error, scope, field, max, length, message }) =>
  Response.json({ ok: false, error, scope, field, max, length, message }, { status: 422 });

// Ліміт заявок з однієї IP. Захист від флуду в Telegram: honeypot ловить лише
// найпростіших ботів, а форму можна слати curl'ом без обмежень.
// Сховище — той самий KV, що й для коментарів (окремий namespace не потрібен).
// Якщо KV не прив'язаний — ліміт просто не застосовується, форма працює далі:
// краще пропустити спам, ніж заблокувати справжнього клієнта.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 3600;

async function checkRateLimit(env, request, bucket) {
  const kv = env.RATE_LIMIT_KV || env.COMMENTS_KV;
  if (!kv) return { allowed: true };

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${bucket}:${ip}`;

  try {
    const current = Number((await kv.get(key)) || 0);
    if (current >= RATE_LIMIT_MAX) return { allowed: false };
    // expirationTtl задає вікно: перший запит стартує відлік, лічильник
    // самознищується через годину — окремого прибирання не потрібно.
    await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
    return { allowed: true };
  } catch (err) {
    console.error('Rate limit check failed:', err);
    return { allowed: true }; // збій сховища не має ламати форму
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  // Honeypot — тихо ігноруємо ботів (справжні заявки з цим полем не блокуємо жорстко)
  if (data && typeof data === 'object' && data.hp_gp_2026) {
    return Response.json({ ok: true });
  }

  // Явна валідація до ліміту й до Telegram: надто довгі значення — це 422 з
  // назвою поля, а не мовчазне обрізання (людина побачила б «успіх», хоча
  // частину ідеї втрачено). Межі спільні з формами: src/lib/lead-validation.js.
  const checked = validateLead(data);
  if (!checked.ok) return rejection(checked);
  const { name, phone, messenger, idea, source, quiz, date, time } = checked.values;

  const isBooking = Boolean(date && time);
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

  // Екранування подовжує текст (& → &amp;), тож перевіряємо вже готове повідомлення.
  const sized = validateTelegramText(text);
  if (!sized.ok) return rejection(sized);

  // Ліміт перевіряємо вже після валідації, щоб биті запити й боти на honeypot
  // не з'їдали квоту справжнього відвідувача з тієї ж IP (спільний офіс, NAT).
  const { allowed } = await checkRateLimit(env, request, 'submit');
  if (!allowed) {
    return Response.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;

  // Раніше тут поверталось ok:true — користувач бачив «Заявку надіслано ✓»,
  // хоча заявка нікуди не пішла, крім логів, які ніхто не читає. Тепер це
  // чесна помилка: фронтенд покаже запасний шлях (написати в Telegram або
  // зателефонувати), і лід не загубиться мовчки через недоналаштований деплой.
  if (!token || !chatId) {
    console.error('TG env not set — заявка не доставлена. Lead:', text);
    return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });
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
    const delivery = await res.json();
    if (delivery?.ok !== true) return Response.json({ ok: false }, { status: 502 });
    return Response.json({ ok: true });
  } catch (err) {
    console.error('Send failed:', err);
    return Response.json({ ok: false }, { status: 502 });
  }
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405 });
}
