// Кабінет передплатників каталогу грантів: вхід за кодом з листа та показ повних карточок.
//
// Платні дані лежать у Supabase (таблиця grant_programs_full) за правилами RLS: їх віддає сервер
// лише користувачу з діючим записом у access_grants. У цьому файлі немає ні платних даних, ні секретів:
// publishable-ключ Supabase призначений для браузера і сам по собі нічого не відкриває.
// Усі мережеві виклики приймають fetch як параметр, тож логіка перевіряється тестом без мережі.

import { formatNumber, formatDate } from './granty.js';

const STORAGE_KEY = 'grantplan-kabinet-session';
const SKEW_S = 60;

/** Налаштування з data-атрибутів сторінки. null, якщо платний рівень ще не підключено. */
export function readConfig(url, key) {
  const u = String(url ?? '').trim().replace(/\/$/, '');
  const k = String(key ?? '').trim();
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(u) || !k) return null;
  return { url: u, key: k };
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : null;
}

const jsonHeaders = (cfg, token) => ({
  apikey: cfg.key,
  Authorization: `Bearer ${token ?? cfg.key}`,
  'Content-Type': 'application/json',
});

/**
 * Надсилає код на пошту. Нових користувачів не створює (create_user: false), тож реєстрації з сайту немає.
 * Відповідь однакова, чи є пошта в списку, щоб не можна було перебором дізнатися, хто наш клієнт.
 */
export async function requestCode(cfg, email, fetchImpl = fetch) {
  const clean = normalizeEmail(email);
  if (!clean) return { ok: false, reason: 'email' };
  let res;
  try {
    res = await fetchImpl(`${cfg.url}/auth/v1/otp`, {
      method: 'POST', headers: jsonHeaders(cfg), body: JSON.stringify({ email: clean, create_user: false }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (res.status === 429) return { ok: false, reason: 'rate' };
  if (res.status >= 500) return { ok: false, reason: 'server' };
  return { ok: true, email: clean };
}

/** Перевіряє код і повертає сесію. */
export async function verifyCode(cfg, email, token, fetchImpl = fetch, now = Date.now()) {
  const clean = normalizeEmail(email);
  const code = String(token ?? '').replace(/\s+/g, '');
  if (!clean || !/^\d{6,10}$/.test(code)) return { ok: false, reason: 'format' };
  let res;
  try {
    res = await fetchImpl(`${cfg.url}/auth/v1/verify`, {
      method: 'POST', headers: jsonHeaders(cfg), body: JSON.stringify({ type: 'email', email: clean, token: code }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!res.ok) return { ok: false, reason: res.status === 429 ? 'rate' : res.status >= 500 ? 'server' : 'code' };
  const body = await res.json().catch(() => null);
  return toSession(body, clean, now) ?? { ok: false, reason: 'server' };
}

export async function refreshSession(cfg, session, fetchImpl = fetch, now = Date.now()) {
  let res;
  try {
    res = await fetchImpl(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: jsonHeaders(cfg), body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!res.ok) return { ok: false, reason: res.status >= 500 ? 'server' : 'expired' };
  const body = await res.json().catch(() => null);
  return toSession(body, session.email, now) ?? { ok: false, reason: 'server' };
}

function toSession(body, email, now) {
  if (!body?.access_token || !body?.refresh_token) return null;
  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
  return {
    ok: true,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Math.floor(now / 1000) + expiresIn,
    email: normalizeEmail(body.user?.email) ?? email,
  };
}

export const sessionFresh = (session, now = Date.now()) => Boolean(session?.access_token) && session.expires_at - SKEW_S > Math.floor(now / 1000);

// ---- збереження сесії (localStorage може бути недоступний: приватний режим, заборонені дані сайту)

export function loadSession(storage) {
  try {
    const s = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    return s?.access_token && s?.refresh_token && s?.email ? s : null;
  } catch {
    return null;
  }
}
export function saveSession(storage, session) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, email: session.email }));
    return true;
  } catch {
    return false;
  }
}
export function clearSession(storage) {
  try { storage.removeItem(STORAGE_KEY); } catch { /* нічого */ }
}

/** Дає чинну сесію: оновлює, якщо токен скоро спливе. null, якщо входити треба заново. */
export async function ensureSession(cfg, storage, fetchImpl = fetch, now = Date.now()) {
  const session = loadSession(storage);
  if (!session) return null;
  if (sessionFresh(session, now)) return session;
  const next = await refreshSession(cfg, session, fetchImpl, now);
  if (!next.ok) {
    if (next.reason === 'expired') clearSession(storage);
    return null;
  }
  saveSession(storage, next);
  return next;
}

// ---- читання даних (RLS на сервері вирішує, що саме людина бачить)

export async function fetchAccess(cfg, session, fetchImpl = fetch) {
  const url = `${cfg.url}/rest/v1/access_grants?select=email,plan,expires_at&email=eq.${encodeURIComponent(session.email)}`;
  const res = await fetchImpl(url, { headers: jsonHeaders(cfg, session.access_token) });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export function accessState(row, now = Date.now()) {
  if (!row) return 'none';
  if (row.expires_at && Date.parse(row.expires_at) <= now) return 'expired';
  return 'active';
}

export async function fetchFullCard(cfg, session, id, fetchImpl = fetch) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const res = await fetchImpl(`${cfg.url}/rest/v1/grant_programs_full?select=data&id=eq.${encodeURIComponent(id)}`, { headers: jsonHeaders(cfg, session.access_token) });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.data ? rows[0].data : null;
}

// ---- розділи повної карточки (чиста функція; DOM будує kabinet-ui.js)

const safeUrl = (u) => (/^https:\/\/[^\s]+$/.test(String(u ?? '')) ? u : null);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

/** Повертає масив розділів { title, type: 'list' | 'text' | 'steps' | 'links' | 'notice', items | text }, порожні пропущено. */
export function describeFull(data) {
  const d = data ?? {};
  const out = [];
  const add = (section) => {
    if ((section.items && section.items.length) || section.text) out.push(section);
  };

  add({
    title: 'Надбавки до суми', type: 'list',
    items: (Array.isArray(d.amount_bonuses) ? d.amount_bonuses : [])
      .filter((b) => b && Number.isFinite(Number(b.percent)) && text(b.condition))
      .map((b) => `+${Number(b.percent)}%: ${text(b.condition)}`),
  });
  add({ title: 'Про суму', type: 'text', text: text(d.amount_note) });

  const allowed = (Array.isArray(d.costs?.allowed) ? d.costs.allowed : []).filter((c) => text(c?.item)).map((c) => {
    let line = text(c.item);
    if (Number.isFinite(Number(c.limit_percent)) && c.limit_percent != null) line += `, не більше ${Number(c.limit_percent)}% суми гранту`;
    if (Number.isFinite(Number(c.limit_amount)) && c.limit_amount != null) line += `, не більше ${formatNumber(Number(c.limit_amount))} грн`;
    return line;
  });
  add({ title: 'На що можна витрачати', type: 'list', items: allowed });
  add({ title: 'Що заборонено', type: 'list', items: list(d.costs?.forbidden) });

  const cof = d.cofinancing ?? {};
  let cofText = text(cof.note);
  if (!cofText && cof.required === false) cofText = 'Власний внесок не вимагається.';
  if (!cofText && Number.isFinite(Number(cof.min_percent)) && cof.min_percent != null) cofText = `Власний внесок щонайменше ${Number(cof.min_percent)}%.`;
  add({ title: 'Власний внесок', type: 'text', text: cofText });

  const obligations = list(d.obligations);
  if (text(d.term)) obligations.push(`Строк: ${text(d.term)}.`);
  add({ title: 'Обов’язки й строки', type: 'list', items: obligations });

  const excluded = list(d.excluded_activities);
  const eligibilityLines = [text(d.eligibility_summary), excluded.length ? `Не підтримують: ${excluded.join('; ')}.` : '', text(d.excluded_regions_note)].filter(Boolean);
  add({ title: 'Умови для заявника', type: 'list', items: eligibilityLines });

  add({ title: 'Про строки', type: 'text', text: text(d.period_note) });
  add({ title: 'Як подати', type: 'text', text: text(d.process?.how_to_apply) });
  add({ title: 'Кроки', type: 'steps', items: list(d.process?.steps) });
  add({ title: 'Підводні камені', type: 'list', items: list(d.pitfalls) });
  add({ title: 'Поради з практики', type: 'list', items: list(d.tips) });

  if (Array.isArray(d.unverified) && d.unverified.length) {
    add({ title: 'Що ще звіряємо', type: 'text', text: 'Частину умов ми ще не звірили з першоджерелом. Перед поданням заявки перевірте їх у оператора програми.' });
  }

  const links = (Array.isArray(d.sources) ? d.sources : [])
    .map((s) => ({ title: text(s?.title), url: safeUrl(s?.url), checked: text(s?.checked) }))
    .filter((s) => s.title && s.url)
    .map((s) => ({ ...s, checkedLabel: s.checked ? formatDate(s.checked) : '' }));
  if (links.length) out.push({ title: 'Першоджерела', type: 'links', items: links });
  return out;
}
