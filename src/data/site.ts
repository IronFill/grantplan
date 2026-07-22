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
  email: 'hello@grantplan.com.ua',
} as const;

// Навігація (якорі лендингу)
export const nav = [
  { label: 'Як це працює', href: '/#how' },
  { label: 'Тарифи', href: '/#pricing' },
  { label: 'Послуги', href: '/#services' },
  { label: 'Приклад роботи', href: '/#case' },
  { label: 'Питання', href: '/#faq' },
] as const;
