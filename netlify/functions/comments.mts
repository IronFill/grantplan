// Netlify Function: коментарі відвідувачів (публікуються одразу, без модерації).
// Зберігання — Netlify Blobs, працює з коробки на Netlify, без окремих env-змінних.
//
// Ендпоінти:
//   GET    /.netlify/functions/comments         — список коментарів (без email)
//   POST   /.netlify/functions/comments         — додати коментар { name, business?, email, text }
//   DELETE /.netlify/functions/comments?id=...  — видалити спам-коментар,
//     потрібен заголовок X-Admin-Token, що збігається з env COMMENTS_ADMIN_TOKEN
//     (якщо змінна не задана — видалення вимкнене).
//
// Опційно: якщо задані TG_BOT_TOKEN / TG_CHAT_ID (ті самі, що для форми заявок),
// про новий коментар прилітає повідомлення в Telegram — щоб бачити спам одразу,
// а не заходити на сайт перевіряти.

import { getStore } from '@netlify/blobs';

const MAX_COMMENTS = 300;
const NAME_MAX = 80;
const BUSINESS_MAX = 100;
const EMAIL_MAX = 120;
const TEXT_MIN = 5;
const TEXT_MAX = 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Прибираємо керівні символи (крім \n), схлопуємо повторні пробіли.
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const cleanText = (s: string) => s.replace(CONTROL_CHARS_RE, '').replace(/[^\S\r\n]+/g, ' ').trim();

const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type StoredComment = {
  id: string;
  name: string;
  business: string;
  email: string;
  text: string;
  createdAt: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function publicView(c: StoredComment) {
  const { email, ...rest } = c;
  return rest;
}

async function notifyTelegram(name: string, business: string, email: string, text: string) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    '\u{1F4AC} <b>Новий коментар на сайті — ГрантПлан</b>',
    `\u{1F464} <b>Ім'я:</b> ${escapeHtml(name)}`,
    business ? `\u{1F3E2} <b>Напрямок:</b> ${escapeHtml(business)}` : '',
    `✉️ <b>Email:</b> ${escapeHtml(email)}`,
    `\u{1F4DD} <b>Текст:</b> ${escapeHtml(text)}`,
  ].filter(Boolean);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('Comment TG notify failed:', err);
  }
}

export default async (request: Request) => {
  const store = getStore('comments');
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const list = ((await store.get('list', { type: 'json' })) as StoredComment[]) || [];
    return json({ ok: true, comments: list.map(publicView) });
  }

  if (request.method === 'POST') {
    let data: Record<string, unknown>;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: 'bad_json' }, 400);
    }

    // Honeypot — тихо ігноруємо ботів, справжньому користувачу поле не показуємо
    if (data.hp_gp_comment) {
      return json({ ok: true });
    }

    const name = cleanText(String(data.name ?? '')).slice(0, NAME_MAX);
    const business = cleanText(String(data.business ?? '')).slice(0, BUSINESS_MAX);
    const email = String(data.email ?? '').trim().slice(0, EMAIL_MAX);
    const text = cleanText(String(data.text ?? '')).slice(0, TEXT_MAX);

    // Ім'я та прізвище — хоча б два слова.
    if (name.split(/\s+/).filter(Boolean).length < 2) {
      return json({ ok: false, error: 'invalid_name' }, 422);
    }
    if (!EMAIL_RE.test(email)) {
      return json({ ok: false, error: 'invalid_email' }, 422);
    }
    if (text.length < TEXT_MIN) {
      return json({ ok: false, error: 'invalid_text' }, 422);
    }

    const comment: StoredComment = {
      id: crypto.randomUUID(),
      name,
      business,
      email,
      text,
      createdAt: new Date().toISOString(),
    };

    const list = ((await store.get('list', { type: 'json' })) as StoredComment[]) || [];
    list.unshift(comment);
    if (list.length > MAX_COMMENTS) list.length = MAX_COMMENTS;
    await store.setJSON('list', list);

    await notifyTelegram(name, business, email, text);

    return json({ ok: true, comment: publicView(comment) });
  }

  if (request.method === 'DELETE') {
    const adminToken = process.env.COMMENTS_ADMIN_TOKEN;
    if (!adminToken) {
      return json({ ok: false, error: 'delete_disabled' }, 403);
    }
    if (request.headers.get('x-admin-token') !== adminToken) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const id = url.searchParams.get('id');
    if (!id) {
      return json({ ok: false, error: 'missing_id' }, 400);
    }

    const list = ((await store.get('list', { type: 'json' })) as StoredComment[]) || [];
    const next = list.filter((c) => c.id !== id);
    await store.setJSON('list', next);

    return json({ ok: true, removed: list.length - next.length });
  }

  return json({ ok: false, error: 'method_not_allowed' }, 405);
};
