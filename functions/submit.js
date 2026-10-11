// Cloudflare Pages Function: приймає заявку з форми та надсилає її в Telegram.
// Змінні оточення (Cloudflare Pages → Settings → Environment variables):
//   TG_BOT_TOKEN — токен бота від @BotFather
//   TG_CHAT_ID   — id чату/каналу для заявок
//
// Ендпоінт: /submit  (POST, JSON)

import { validateLead, validateTelegramText } from '../src/lib/lead-validation.js';
import { deliverLead, leadMessage } from '../src/lib/lead-delivery.js';

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
  const text = leadMessage(checked.values);

  // Екранування подовжує текст (& → &amp;), тож перевіряємо вже готове повідомлення.
  const sized = validateTelegramText(text);
  if (!sized.ok) return rejection(sized);

  // Ліміт перевіряємо вже після валідації, щоб биті запити й боти на honeypot
  // не з'їдали квоту справжнього відвідувача з тієї ж IP (спільний офіс, NAT).
  const { allowed } = await checkRateLimit(env, request, 'submit');
  if (!allowed) {
    return Response.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  const result = await deliverLead({
    store: env.LEADS_KV || env.COMMENTS_KV,
    token: env.TG_BOT_TOKEN, chatId: env.TG_CHAT_ID,
    requestId: data.requestId, values: checked.values, text,
  });
  return Response.json(result.body, { status: result.status });
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405 });
}
