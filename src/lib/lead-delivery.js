// A private outbox prevents silent loss. KV is eventually consistent: this is
// best-effort deduplication, not a transactional exactly-once guarantee.
const TTL = 30 * 24 * 3600;
const escape = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function leadMessage(v) {
  return [
    v.date && v.time ? '🗓️ <b>Запит на консультацію — ГрантПлан</b>' : '🟠 <b>Нова заявка — ГрантПлан</b>',
    v.date ? `📅 <b>Бажана дата:</b> ${escape(v.date)}` : '',
    v.time ? `🕐 <b>Бажаний час (Київ):</b> ${escape(v.time)}` : '',
    `👤 <b>Ім’я:</b> ${escape(v.name)}`, `📞 <b>Телефон:</b> ${escape(v.phone)}`,
    v.messenger ? `💬 <b>Месенджер:</b> ${escape(v.messenger)}` : '',
    v.idea ? `💡 <b>Ідея:</b> ${escape(v.idea)}` : '',
    v.quiz ? `🧮 <b>Квіз:</b> ${escape(v.quiz)}` : '', `🔖 <b>Джерело:</b> ${escape(v.source)}`,
  ].filter(Boolean).join('\n');
}

export async function deliverLead({ store, token, chatId, requestId, values, text }) {
  if (!token || !chatId) return { status: 503, body: { ok: false, error: 'not_configured' } };
  const id = requestId || crypto.randomUUID();
  const key = `lead:${id}`;
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(values))))).map(n => n.toString(16).padStart(2, '0')).join('');
  let record;
  const save = async () => store?.put(key, JSON.stringify(record), { expirationTtl: TTL });
  if (store) {
    try {
      const old = await store.get(key);
      record = old ? JSON.parse(old) : null;
      if (record && record.fingerprint !== fingerprint) return { status: 409, body: { ok: false, error: 'request_conflict' } };
      if (record?.state === 'sent') return { status: 200, body: { ok: true, duplicate: true } };
      if (record && ['sending', 'uncertain'].includes(record.state)) {
        return { status: 409, body: { ok: false, saved: true, error: 'delivery_unconfirmed' } };
      }
      record ||= { id, fingerprint, values, createdAt: new Date().toISOString() };
      record.state = 'sending';
      record.updatedAt = new Date().toISOString();
      await save(); // Do not send if the configured outbox cannot persist.
    } catch {
      return { status: 503, body: { ok: false, error: 'storage_unavailable' } };
    }
  }
  let state = 'uncertain';
  let ok = false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000),
    });
    // Only an explicit Telegram rejection is safe to retry. A network timeout
    // can mean the message arrived; preserve it for owner reconciliation.
    let payload;
    try { payload = await response.json(); } catch { /* Unknown delivery. */ }
    ok = response.ok && payload?.ok === true;
    state = ok ? 'sent' : payload?.ok === false ? 'failed' : 'uncertain';
  } catch { /* No logs containing contact data, bot tokens or upstream URLs. */ }
  if (store) {
    record.state = state;
    record.updatedAt = new Date().toISOString();
    try { await save(); } catch {
      // Successful delivery remains success; a previous sending record blocks
      // a duplicate if the final state cannot be committed.
      console.error('Lead outbox status update failed');
    }
  }
  return ok ? { status: 200, body: { ok: true } } : {
    status: 502, body: { ok: false, saved: Boolean(store), error: 'delivery_unconfirmed' },
  };
}
