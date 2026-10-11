// Cloudflare Pages Function: �਩��� ��� � �ନ � ���ᨫ�� �� � Telegram.
// ��?��? ��祭�� (Cloudflare Pages  Settings  Environment variables):
//   TG_BOT_TOKEN - ⮪�� ��� �?� @BotFather
//   TG_CHAT_ID   - id ���/������ ��� ���
//
// �����?��: /submit  (POST, JSON)

const escape = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// �?�?� ��� � ���?�� IP. ����� �?� ��� � Telegram: honeypot ������ ���
// �������?�� ���?�, � ��� ����� ᫠� curl'�� ��� ��������.
// �客�� - ⮩ ᠬ�� KV, � � ��� �������?� (��६�� namespace �� ����?���).
// ��� KV �� �ਢ'易��� - �?�?� ���� �� ����ᮢ������, �ଠ ����� ���?:
// ��� �ய���� ᯠ�, �?� ������㢠� �ࠢ��쮣� ��?��.
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
    // expirationTtl ����� �?���: ���訩 ����� ������ �?��?�, �?稫쭨�
    // ᠬ����������� �१ ������ - ��६��� �ਡ�࠭�� �� ����?���.
    await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
    return { allowed: true };
  } catch (err) {
    console.error('Rate limit check failed:', err);
    return { allowed: true }; // ��?� �客�� �� ��� ����� ���
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

  // Honeypot - �� ?������ ���?� (�ࠢ��? ��� � 樬 ����� �� ������ ����⪮)
  if (data.hp_gp_2026) {
    return Response.json({ ok: true });
  }

  const { name = '', phone = '', messenger = '', idea = '', source = 'form', quiz = '', date = '', time = '' } = data;

  if (!name || !/^\+380\d{9}$/.test(phone)) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 422 });
  }

  // �?�?� ��ॢ?��� ��� �?�� ���?���?�, 鮡 ���? ����� � ��� �� honeypot
  // �� �'����� ����� �ࠢ��쮣� �?��?�㢠� � �?�� � IP (�?�쭨� ��?�, NAT).
  const { allowed } = await checkRateLimit(env, request, 'submit');
  if (!allowed) {
    return Response.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;

  const isBooking = Boolean(date && time);
  const lines = [
    isBooking ? '??? <b>����� �� ��������?� - �࠭⏫��</b>' : '?? <b>���� ��� - �࠭⏫��</b>',
    date ? `?? <b>���:</b> ${escape(date)}` : '',
    time ? `?? <b>���:</b> ${escape(time)}` : '',
    `?? <b>?�'�:</b> ${escape(name)}`,
    `?? <b>����䮭:</b> ${escape(phone)}`,
    messenger ? `?? <b>��ᥭ����:</b> ${escape(messenger)}` : '',
    idea ? `?? <b>?���:</b> ${escape(idea)}` : '',
    quiz ? `?? <b>��?�:</b> ${escape(quiz)}` : '',
    `?? <b>���५�:</b> ${escape(source)}`,
  ].filter(Boolean);

  const text = lines.join('\n');

  // ���?� ��� �����⠫��� ok:true - �����㢠� ��稢 <��� ���?᫠�� ?>,
  // �� ��� �?�㤨 �� �?諠, ��?� ���?�, �? �?�� �� ���. ����� �
  // �᭠ �������: �஭⥭� ������ ����᭨� ��� (������ � Telegram ���
  // ��⥫�䮭㢠�), ? �?� �� ���㡨���� ���窨 �१ ���������⮢���� ������.
  if (!token || !chatId) {
    console.error('TG env not set - ��� �� ���⠢����. Lead:', text);
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
    if (delivery?.ok !== true) {
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
