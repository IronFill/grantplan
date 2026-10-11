// Netlify Function: приймає заявку з форми та надсилає її в Telegram.
// Змінні оточення (Netlify → Site settings → Environment variables):
//   TG_BOT_TOKEN — токен бота від @BotFather
//   TG_CHAT_ID   — id чату/каналу для заявок
//
// Ендпоінт: /.netlify/functions/submit  (POST, JSON)

import { validateLead, validateTelegramText } from '../../src/lib/lead-validation.js';
import { deliverLead, leadMessage } from '../../src/lib/lead-delivery.js';
import { connectLambda, getStore } from '@netlify/blobs';

// Відповідь на відхилену заявку: лише безпечні поля, без внутрішніх деталей.
const rejection = ({ error, scope, field, max, length, message }) => ({
  statusCode: 422,
  body: JSON.stringify({ ok: false, error, scope, field, max, length, message }),
});

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
  if (data && typeof data === 'object' && data.hp_gp_2026) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // Явна валідація до Telegram: надто довгі значення — це 422 з назвою поля,
  // а не мовчазне обрізання. Межі спільні з формами і з Cloudflare-обробником:
  // src/lib/lead-validation.js.
  const checked = validateLead(data);
  if (!checked.ok) return rejection(checked);
  const text = leadMessage(checked.values);

  // Екранування подовжує текст (& → &amp;), тож перевіряємо вже готове повідомлення.
  const sized = validateTelegramText(text);
  if (!sized.ok) return rejection(sized);

  // Netlify uses the existing Blobs service; local unit tests have no site context.
  let store;
  if (event.blobs || process.env.NETLIFY === 'true' || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    try {
      if (event.blobs) connectLambda(event);
      const blobs = getStore({ name: 'grantplan-leads', consistency: 'strong' });
      store = { get: key => blobs.get(key), put: (key, value) => blobs.set(key, value) };
      const ip = event.headers?.['x-nf-client-connection-ip'];
      if (!ip) return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'rate_limit_unavailable' }) };
      const key = 'rate:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)))).map(n => n.toString(16).padStart(2,'0')).join('');
      const prior = await blobs.get(key, { type: 'json' });
      const now = Date.now();
      const current = prior && prior.until > now ? prior : { count: 0, until: now + 3600000 };
      if (current.count >= 5) return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'rate_limited' }) };
      await blobs.setJSON(key, { ...current, count: current.count + 1 });
    } catch {
      return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'storage_unavailable' }) };
    }
  }
  const result = await deliverLead({ store, token: process.env.TG_BOT_TOKEN,
    chatId: process.env.TG_CHAT_ID, requestId: data.requestId, values: checked.values, text });
  return { statusCode: result.status, body: JSON.stringify(result.body) };
};
