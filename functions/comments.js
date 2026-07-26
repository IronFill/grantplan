// Cloudflare Pages Function: коментарі відвідувачів (парний ендпоінт до
// netlify/functions/comments.mts — на випадок деплою на Cloudflare Pages
// замість Netlify). Потребує KV namespace, прив'язаний під назвою COMMENTS_KV
// (Cloudflare Pages → Settings → Functions → KV namespace bindings).
//
// Без прив'язаного KV коментарі показати чи зберегти неможливо — ендпоінт
// чесно повертає 503, а не вдає, що дані збереглись.
//
// Ендпоінти:
//   GET    /comments         — список коментарів (без email)
//   POST   /comments         — додати коментар { name, email, text }
//   DELETE /comments?id=...  — видалити спам-коментар, потрібен заголовок
//     X-Admin-Token, що збігається з env COMMENTS_ADMIN_TOKEN.

const MAX_COMMENTS = 300;
const NAME_MAX = 80;
const EMAIL_MAX = 120;
const TEXT_MIN = 5;
const TEXT_MAX = 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const cleanText = (s) => s.replace(CONTROL_CHARS_RE, '').replace(/[^\S\r\n]+/g, ' ').trim();

const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const publicView = ({ email, ...rest }) => rest;

async function getList(kv) {
  return (await kv.get('list', { type: 'json' })) || [];
}

async function notifyTelegram(env, name, email, text) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    '💬 <b>Новий коментар на сайті — ГрантПлан</b>',
    `👤 <b>Ім'я:</b> ${escapeHtml(name)}`,
    `✉️ <b>Email:</b> ${escapeHtml(email)}`,
    `📝 <b>Текст:</b> ${escapeHtml(text)}`,
  ];

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
  const kv = context.env.COMMENTS_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'storage_not_configured' }, { status: 503 });
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

  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }

  if (data.hp_gp_comment) {
    return Response.json({ ok: true });
  }

  const name = cleanText(String(data.name ?? '')).slice(0, NAME_MAX);
  const email = String(data.email ?? '').trim().slice(0, EMAIL_MAX);
  const text = cleanText(String(data.text ?? '')).slice(0, TEXT_MAX);

  if (name.length < 2) {
    return Response.json({ ok: false, error: 'invalid_name' }, { status: 422 });
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 422 });
  }
  if (text.length < TEXT_MIN) {
    return Response.json({ ok: false, error: 'invalid_text' }, { status: 422 });
  }

  const comment = {
    id: crypto.randomUUID(),
    name,
    email,
    text,
    createdAt: new Date().toISOString(),
  };

  const list = await getList(kv);
  list.unshift(comment);
  if (list.length > MAX_COMMENTS) list.length = MAX_COMMENTS;
  await kv.put('list', JSON.stringify(list));

  await notifyTelegram(env, name, email, text);

  return Response.json({ ok: true, comment: publicView(comment) });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const kv = env.COMMENTS_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'storage_not_configured' }, { status: 503 });
  }

  const adminToken = env.COMMENTS_ADMIN_TOKEN;
  if (!adminToken) {
    return Response.json({ ok: false, error: 'delete_disabled' }, { status: 403 });
  }
  if (request.headers.get('x-admin-token') !== adminToken) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return Response.json({ ok: false, error: 'missing_id' }, { status: 400 });
  }

  const list = await getList(kv);
  const next = list.filter((c) => c.id !== id);
  await kv.put('list', JSON.stringify(next));

  return Response.json({ ok: true, removed: list.length - next.length });
}
