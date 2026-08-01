// Cloudflare Pages Function: коментарі відвідувачів (парний ендпоінт до
// netlify/functions/comments.mts — на випадок деплою на Cloudflare Pages
// замість Netlify). Потребує KV namespace, прив'язаний під назвою COMMENTS_KV
// (Cloudflare Pages → Settings → Functions → KV namespace bindings).
//
// Без прив'язаного KV коментарі показати чи зберегти неможливо — ендпоінт
// чесно повертає 503, а не вдає, що дані збереглись.
//
// МОДЕРАЦІЯ: коментар НЕ з'являється на сайті одразу. Новий коментар лягає
// в окремий ключ `pending:<id>` і потрапляє в публічний список лише після
// явного схвалення адміністратором. До цього сайт консультаційної практики
// був відкритий для миттєвої публікації будь-чого — реклами конкурентів,
// образ, спаму — без жодного бар'єру.
//
// Побічний виграш: публічний POST більше не робить read-modify-write над
// спільним ключем `list`, тож два одночасні коментарі не затирають один
// одного (у KV немає транзакцій — попередня схема це допускала).
//
// Ендпоінти:
//   GET    /comments                      — схвалені коментарі (без email)
//   POST   /comments                      — надіслати коментар на модерацію
//   GET    /comments?pending=1            — черга модерації (X-Admin-Token)
//   POST   /comments?action=approve&id=…  — схвалити коментар (X-Admin-Token)
//   DELETE /comments?id=…                 — видалити коментар (X-Admin-Token)

const MAX_COMMENTS = 300;
const NAME_MAX = 80;
const BUSINESS_MAX = 100;
const EMAIL_MAX = 120;
const TEXT_MIN = 5;
const TEXT_MAX = 1000;

// Ліміт на надсилання коментарів з однієї IP (див. той самий підхід у submit.js)
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_SEC = 3600;

const PENDING_PREFIX = 'pending:';
const PENDING_TTL_SEC = 60 * 60 * 24 * 90; // нерозглянуті самознищуються через 90 днів

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const cleanText = (s) => s.replace(CONTROL_CHARS_RE, '').replace(/[^\S\r\n]+/g, ' ').trim();

const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const publicView = ({ email, ...rest }) => rest;

async function getList(kv) {
  return (await kv.get('list', { type: 'json' })) || [];
}

function isAdmin(request, env) {
  const adminToken = env.COMMENTS_ADMIN_TOKEN;
  if (!adminToken) return false;
  return request.headers.get('x-admin-token') === adminToken;
}

async function checkRateLimit(env, request) {
  const kv = env.RATE_LIMIT_KV || env.COMMENTS_KV;
  if (!kv) return { allowed: true };

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:comments:${ip}`;

  try {
    const current = Number((await kv.get(key)) || 0);
    if (current >= RATE_LIMIT_MAX) return { allowed: false };
    await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
    return { allowed: true };
  } catch (err) {
    console.error('Rate limit check failed:', err);
    return { allowed: true };
  }
}

async function notifyTelegram(env, comment) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    '💬 <b>Коментар на модерації — ГрантПлан</b>',
    `👤 <b>Ім'я:</b> ${escapeHtml(comment.name)}`,
    comment.business ? `🏢 <b>Напрямок:</b> ${escapeHtml(comment.business)}` : '',
    `✉️ <b>Email:</b> ${escapeHtml(comment.email)}`,
    `📝 <b>Текст:</b> ${escapeHtml(comment.text)}`,
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const kv = env.COMMENTS_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'storage_not_configured' }, { status: 503 });
  }

  const url = new URL(request.url);

  // Черга модерації — тільки для адміністратора.
  if (url.searchParams.get('pending') === '1') {
    if (!isAdmin(request, env)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    const { keys } = await kv.list({ prefix: PENDING_PREFIX });
    const pending = [];
    for (const k of keys) {
      const c = await kv.get(k.name, { type: 'json' });
      if (c) pending.push(c);
    }
    pending.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return Response.json({ ok: true, pending });
  }

  const list = await getList(kv);
  return Response.json({ ok: true, comments: list.map(publicView) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.COMMENTS_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'storage_not_configured' }, { status: 503 });
  }

  const url = new URL(request.url);

  // --- Схвалення коментаря адміністратором ---
  if (url.searchParams.get('action') === 'approve') {
    if (!isAdmin(request, env)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ ok: false, error: 'missing_id' }, { status: 400 });
    }

    const pendingKey = PENDING_PREFIX + id;
    const comment = await kv.get(pendingKey, { type: 'json' });
    if (!comment) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }

    const list = await getList(kv);
    if (!list.some((c) => c.id === comment.id)) {
      list.unshift({ ...comment, approvedAt: new Date().toISOString() });
      if (list.length > MAX_COMMENTS) list.length = MAX_COMMENTS;
      await kv.put('list', JSON.stringify(list));
    }
    await kv.delete(pendingKey);

    return Response.json({ ok: true, approved: comment.id });
  }

  // --- Новий коментар від відвідувача ---
  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }

  if (data.hp_gp_comment) {
    return Response.json({ ok: true, status: 'pending' });
  }

  const name = cleanText(String(data.name ?? '')).slice(0, NAME_MAX);
  const business = cleanText(String(data.business ?? '')).slice(0, BUSINESS_MAX);
  const email = String(data.email ?? '').trim().slice(0, EMAIL_MAX);
  const text = cleanText(String(data.text ?? '')).slice(0, TEXT_MAX);

  // Ім'я та прізвище — хоча б два слова.
  if (name.split(/\s+/).filter(Boolean).length < 2) {
    return Response.json({ ok: false, error: 'invalid_name' }, { status: 422 });
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 422 });
  }
  if (text.length < TEXT_MIN) {
    return Response.json({ ok: false, error: 'invalid_text' }, { status: 422 });
  }

  const { allowed } = await checkRateLimit(env, request);
  if (!allowed) {
    return Response.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  const comment = {
    id: crypto.randomUUID(),
    name,
    business,
    email,
    text,
    createdAt: new Date().toISOString(),
  };

  // Пишемо в окремий ключ, а не в спільний масив: немає read-modify-write,
  // тож одночасні надсилання не затирають одне одного.
  await kv.put(PENDING_PREFIX + comment.id, JSON.stringify(comment), {
    expirationTtl: PENDING_TTL_SEC,
  });

  await notifyTelegram(env, comment);

  // Коментар свідомо НЕ повертається для миттєвого показу — він ще не схвалений.
  return Response.json({ ok: true, status: 'pending' });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const kv = env.COMMENTS_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'storage_not_configured' }, { status: 503 });
  }

  if (!env.COMMENTS_ADMIN_TOKEN) {
    return Response.json({ ok: false, error: 'delete_disabled' }, { status: 403 });
  }
  if (!isAdmin(request, env)) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return Response.json({ ok: false, error: 'missing_id' }, { status: 400 });
  }

  // Видаляємо і зі схвалених, і з черги модерації — id той самий.
  const list = await getList(kv);
  const next = list.filter((c) => c.id !== id);
  if (next.length !== list.length) {
    await kv.put('list', JSON.stringify(next));
  }
  await kv.delete(PENDING_PREFIX + id);

  return Response.json({ ok: true, removed: list.length - next.length });
}
