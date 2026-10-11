// Netlify Function: �਩��� ��� � �ନ � ���ᨫ�� �� � Telegram.
// ��?��? ��祭�� (Netlify  Site settings  Environment variables):
//   TG_BOT_TOKEN - ⮪�� ��� �?� @BotFather
//   TG_CHAT_ID   - id ���/������ ��� ���
//
// �����?��: /.netlify/functions/submit  (POST, JSON)

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

  // Honeypot - �� ?������ ���?� (�ࠢ��? ��� � 樬 ����� �� ������ ����⪮)
  if (data.hp_gp_2026) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const { name = '', phone = '', messenger = '', idea = '', source = 'form', quiz = '', date = '', time = '' } = data;

  if (!name || !/^\+380\d{9}$/.test(phone)) {
    return { statusCode: 422, body: JSON.stringify({ ok: false, error: 'invalid' }) };
  }

  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

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

  // ���?� ��� �����⠢�� ok:true - �����㢠� ��稢 <��� ���?᫠�� ?>,
  // �� ��� ��蠫��� �?�쪨 � �����. ����� � �᭠ �������: �஭⥭�
  // ������ ����᭨� ��� (Telegram / ���?���), ? �?� �� ���㡨���� ���窨.
  if (!token || !chatId) {
    console.error('TG env not set - ��� �� ���⠢����. Lead:', text);
    return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'not_configured' }) };
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
    const delivery = await res.json();
    if (delivery?.ok !== true) {
      return { statusCode: 502, body: JSON.stringify({ ok: false }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Send failed:', err);
    return { statusCode: 502, body: JSON.stringify({ ok: false }) };
  }
};

// --- FALLBACK: Formspree (஧�������� ? �ਡ��?�� Telegram-���� ���) ---
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
