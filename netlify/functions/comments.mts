// Netlify Function: коментарі відвідувачів.
// Зберігання — Netlify Blobs, працює з коробки на Netlify, без окремих env-змінних.
//
// МОДЕРАЦІЯ: коментар не публікується одразу — лягає в чергу (`pending:<id>`)
// і з'являється на сайті лише після схвалення адміністратором. Дзеркалить
// поведінку functions/comments.js (Cloudflare Pages — основний хостинг), щоб
// переїзд між платформами не вмикав мовчки миттєву публікацію будь-чого.
//
// Ендпоінти:
//   GET    /.netlify/functions/comments                      — схвалені (без email)
//   POST   /.netlify/functions/comments                      — надіслати на модерацію
//   GET    /.netlify/functions/comments?pending=1            — черга (X-Admin-Token)
//   POST   /.netlify/functions/comments?action=approve&id=…  — схвалити (X-Admin-Token)
//   DELETE /.netlify/functions/comments?id=…                 — видалити (X-Admin-Token)
//
// Опційно: якщо задані TG_BOT_TOKEN / TG_CHAT_ID (ті самі, що для форми заявок),
// про новий коментар прилітає повідомлення в Telegram разом з id для схвалення.

import { getStore } from '@netlify/blobs';

const MAX_COMMENTS = 300;
const NAME_MAX = 80;
const BUSINESS_MAX = 100;
const EMAIL_MAX = 120;
const TEXT_MIN = 5;
const TEXT_MAX = 1000;

const PENDING_PREFIX = 'pending:';

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
  approvedAt?: string;
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

function isAdmin(request: Request) {
  const adminToken = process.env.COMMENTS_ADMIN_TOKEN;
  if (!adminToken) return false;
  return request.headers.get('x-admin-token') === adminToken;
}

async function notifyTelegram(comment: StoredComment) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    '\u{1F4AC} <b>Коментар на модерації — ГрантПлан</b>',
    `\u{1F464} <b>Ім'я:</b> ${escapeHtml(comment.name)}`,
    comment.business ? `\u{1F3E2} <b>Напрямок:</b> ${escapeHtml(comment.business)}` : '',
    `✉️ <b>Email:</b> ${escapeHtml(comment.email)}`,
    `\u{1F4DD} <b>Текст:</b> ${escapeHtml(comment.text)}`,
    '',
    `<b>ID для схвалення:</b> <code>${escapeHtml(comment.id)}</code>`,
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

  const getApproved = async () =>
    ((await store.get('list', { type: 'json' })) as StoredComment[]) || [];

  if (request.method === 'GET') {
    // Черга модерації — тільки для адміністратора.
    if (url.searchParams.get('pending') === '1') {
      if (!isAdmin(request)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      const { blobs } = await store.list({ prefix: PENDING_PREFIX });
      const pending: StoredComment[] = [];
      for (const b of blobs) {
        const c = (await store.get(b.key, { type: 'json' })) as StoredComment | null;
        if (c) pending.push(c);
      }
      pending.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json({ ok: true, pending });
    }

    const list = await getApproved();
    return json({ ok: true, comments: list.map(publicView) });
  }

  if (request.method === 'POST') {
    // --- Схвалення коментаря адміністратором ---
    if (url.searchParams.get('action') === 'approve') {
      if (!isAdmin(request)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      const id = url.searchParams.get('id');
      if (!id) {
        return json({ ok: false, error: 'missing_id' }, 400);
      }

      const pendingKey = PENDING_PREFIX + id;
      const comment = (await store.get(pendingKey, { type: 'json' })) as StoredComment | null;
      if (!comment) {
        return json({ ok: false, error: 'not_found' }, 404);
      }

      const list = await getApproved();
      if (!list.some((c) => c.id === comment.id)) {
        list.unshift({ ...comment, approvedAt: new Date().toISOString() });
        if (list.length > MAX_COMMENTS) list.length = MAX_COMMENTS;
        await store.setJSON('list', list);
      }
      await store.delete(pendingKey);

      return json({ ok: true, approved: comment.id });
    }

    // --- Новий коментар від відвідувача ---
    let data: Record<string, unknown>;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: 'bad_json' }, 400);
    }

    // Honeypot — тихо ігноруємо ботів, справжньому користувачу поле не показуємо
    if (data.hp_gp_comment) {
      return json({ ok: true, status: 'pending' });
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

    // Окремий ключ замість read-modify-write над спільним `list`:
    // одночасні надсилання не затирають одне одного.
    await store.setJSON(PENDING_PREFIX + comment.id, comment);

    await notifyTelegram(comment);

    // Коментар свідомо НЕ повертається для миттєвого показу — він ще не схвалений.
    return json({ ok: true, status: 'pending' });
  }

  if (request.method === 'DELETE') {
    if (!process.env.COMMENTS_ADMIN_TOKEN) {
      return json({ ok: false, error: 'delete_disabled' }, 403);
    }
    if (!isAdmin(request)) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const id = url.searchParams.get('id');
    if (!id) {
      return json({ ok: false, error: 'missing_id' }, 400);
    }

    // Видаляємо і зі схвалених, і з черги модерації — id той самий.
    const list = await getApproved();
    const next = list.filter((c) => c.id !== id);
    if (next.length !== list.length) {
      await store.setJSON('list', next);
    }
    await store.delete(PENDING_PREFIX + id);

    return json({ ok: true, removed: list.length - next.length });
  }

  return json({ ok: false, error: 'method_not_allowed' }, 405);
};
