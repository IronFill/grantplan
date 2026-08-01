// ============================================================
//  ЦЕНТРАЛЬНИЙ КОНФІГ — замініть плейсхолдери перед деплоєм.
//  Пошук: [PHONE], [TG_LINK] тощо (див. README, розділ «Плейсхолдери»).
// ============================================================

export const site = {
  brand: 'ГрантПлан',
  city: 'Харків',
  // Телефон у форматі +380XXXXXXXXX (без пробілів для tel:)
  phone: '+380930963393',
  phoneDisplay: '+380 93 096 33 93',
  // Месенджери (WhatsApp і Viber — на цьому ж номері)
  telegram: 'https://t.me/grantplan_ua',
  viber: 'viber://chat?number=%2B380930963393',
  whatsapp: 'https://wa.me/380930963393',
  // Основний домен (для canonical / OG). Дублює astro.config.mjs site.
  url: 'https://grantplan.com.ua',
  email: 'grantplan@ukr.net',
} as const;

// Реквізити виконавця. Стаття 7 Закону «Про електронну комерцію» вимагає,
// щоб продавець послуг розкривав повне найменування та місцезнаходження.
// Поки поля порожні, сайт їх просто не показує (замість «[ПІБ]» у футері),
// але юридично їх треба заповнити до прийому оплат:
//   legalName — напр. 'ФОП Прізвище Ім’я По батькові'
//   taxId     — РНОКПП або ЄДРПОУ
//   address   — місцезнаходження (місто, вулиця, індекс)
export const legalEntity = {
  legalName: '',
  taxId: '',
  address: '',
} as const;

/** Чи заповнені реквізити виконавця — керує показом юридичного блоку. */
export const hasLegalEntity = Boolean(legalEntity.legalName);

// Навігація (якорі лендингу)
export const nav = [
  { label: 'Умови програми', href: '/umovy-prohramy' },
  { label: 'Як це працює', href: '/#how' },
  { label: 'Тарифи', href: '/#pricing' },
  { label: 'Послуги', href: '/#services' },
  { label: 'Приклад роботи', href: '/#case' },
  { label: 'Питання', href: '/#faq' },
  { label: 'Блог', href: '/blog' },
] as const;
