import { validBooking } from './booking-clock.js';
// Єдина серверна валідація заявки з форм (основна форма запису й квіз).
//
// Один модуль для обох обробників (functions/submit.js — Cloudflare Pages,
// netlify/functions/submit.mjs — запасний хостинг) і для форм на сторінці:
// LeadForm.astro та Quiz.astro беруть maxlength із LEAD_LIMITS, тож межі в
// браузері й на сервері не можуть розійтися.
//
// Довжина рахується в одиницях UTF-16 (String.length) — тими самими, що й
// атрибут maxlength у браузері, тож межі на сторінці й на сервері збігаються
// точно (емодзі — це 2 одиниці). Нічого не обрізається мовчки: надто довге
// значення — це відповідь 422 з назвою поля та межею.

/** Найбільша довжина кожного поля, у символах. */
export const LEAD_LIMITS = Object.freeze({
  name: 100,
  messenger: 40,
  idea: 1000,
  source: 40,
  date: 60,
  time: 20,
  // Приховане поле квізу: JSON відповідей + результат. Реальний максимум
  // сьогодні — 875 символів (усі 9 блокуючих умов); перевіряється тестом
  // scripts/test-lead-limits.mjs проти Quiz.astro.
  quiz: 1500,
});

/** Назви полів для повідомлень користувачу. */
export const LEAD_FIELD_LABELS = Object.freeze({
  name: 'Ім’я',
  phone: 'Телефон',
  messenger: 'Месенджер',
  idea: 'Коротко про ідею',
  source: 'Джерело',
  date: 'Дата',
  time: 'Час',
  quiz: 'Відповіді квізу',
});

/**
 * Ліміт Telegram sendMessage: 4096 символів тексту ПІСЛЯ розбору розмітки
 * (теги <b> і сутності &amp; &lt; &gt; у ліміт не входять).
 */
export const TELEGRAM_TEXT_LIMIT = 4096;

export const PHONE_PATTERN = /^\+380\d{9}$/;

/** Довжина в одиницях UTF-16 — як у maxlength і в String.length. */
export const charLength = (s) => String(s).length;

const STRING_FIELDS = ['name', 'phone', 'messenger', 'idea', 'source', 'quiz', 'date', 'time'];

const tooLongMessage = (field, max, length) =>
  `Поле «${LEAD_FIELD_LABELS[field]}» задовге: максимум ${max} символів, зараз ${length}. Скоротіть текст — ми нічого не обрізаємо мовчки.`;

/**
 * Перевіряє тіло заявки.
 * Повертає { ok: true, values } або { ok: false, status: 422, error, field?, max?, length?, message }.
 *   error: 'invalid'   — немає імені / некоректний телефон / неправильний тип поля
 *          'too_long'  — значення довше за LEAD_LIMITS (або повідомлення завелике для Telegram)
 * Honeypot тут не перевіряється — це справа обробника (боту віддаємо ok:true).
 */
export function validateLead(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, status: 422, error: 'invalid', message: 'Некоректні дані заявки.' };
  }

  const values = { source: 'form' };
  for (const field of STRING_FIELDS) {
    const raw = data[field];
    if (raw === undefined || raw === null) {
      values[field] ??= '';
      continue;
    }
    if (typeof raw !== 'string') {
      return { ok: false, status: 422, error: 'invalid', field, message: `Поле «${LEAD_FIELD_LABELS[field]}» має бути текстом.` };
    }
    values[field] = raw;
  }
  if (values.source === '') values.source = 'form';

  if (!values.name.trim()) {
    return { ok: false, status: 422, error: 'invalid', field: 'name', message: 'Вкажіть, будь ласка, ім’я.' };
  }
  if (!PHONE_PATTERN.test(values.phone)) {
    return { ok: false, status: 422, error: 'invalid', field: 'phone', message: 'Введіть коректний номер у форматі +380XXXXXXXXX.' };
  }

  for (const [field, max] of Object.entries(LEAD_LIMITS)) {
    const length = charLength(values[field]);
    if (length > max) {
      return { ok: false, status: 422, error: 'too_long', field, max, length, message: tooLongMessage(field, max, length) };
    }
  }

  if (data.consent !== 'on' && data.consent !== true) {
    return { ok: false, status: 422, error: 'invalid', field: 'consent', message: 'Потрібна згода на обробку персональних даних.' };
  }
  if (data.requestId !== undefined) {
    if (typeof data.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.requestId)) {
      return { ok: false, status: 422, error: 'invalid', field: 'requestId', message: 'Оновіть сторінку та спробуйте ще раз.' };
    }
    if (!validBooking(values.date, values.time)) {
      return { ok: false, status: 422, error: 'invalid', field: 'date', message: 'Оберіть коректні дату та час у календарі.' };
    }
  }
  return { ok: true, values };
}

/**
 * Довжина тексту так, як її бачить Telegram: без тегів <b> і з розкритими
 * сутностями (ми самі генеруємо лише <b>, &amp;, &lt; і &gt;; тексти
 * користувача проходять escape у обробниках). Рахуємо в одиницях UTF-16 —
 * консервативно для емодзі: краще явно попросити скоротити текст, ніж
 * отримати від Telegram відмову вже після відправки. Сума всіх лімітів полів
 * сьогодні ≈ 2,9 тис. символів, тож ця перевірка — страховка на випадок, якщо
 * ліміти колись піднімуть.
 */
export const telegramVisibleLength = (htmlText) =>
  String(htmlText)
    .replace(/<\/?b>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').length;

/**
 * Перевіряє готовий (HTML) текст для Telegram. Поля окремо вкладаються в свої
 * межі, але разом з емодзі вони можуть не вмістись у 4096 — це теж явна
 * відмова 422 (scope: 'message'), а не мовчазне обрізання. У відповіді вказано
 * поле «idea» — найбільш імовірне для скорочення.
 */
export function validateTelegramText(htmlText) {
  const length = telegramVisibleLength(htmlText);
  if (length <= TELEGRAM_TEXT_LIMIT) return { ok: true };
  return {
    ok: false,
    status: 422,
    error: 'too_long',
    scope: 'message',
    field: 'idea',
    max: LEAD_LIMITS.idea,
    length,
    message: 'Заявка завелика для відправлення: скоротіть текст ідеї (емодзі займають більше місця, ніж літери).',
  };
}
