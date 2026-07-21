# ГрантПлан — лендинг

Production-ready лендинг юридичної послуги підготовки бізнес-планів під державний грант **«Власна справа»** (Харків, по всій Україні).

Стек: **Astro 5** (статична збірка) + **Tailwind CSS 4** + ванільний JS (островки). Шрифти — Manrope + Inter через `@fontsource`. Форми — Telegram Bot API через Netlify Function.

---

## 1. Локальний запуск

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # збірка у dist/
npm run preview    # локальний перегляд збірки
```

Node ≥ 20.

Структура (Astro у корені репозиторію):

```
.
├─ src/
│  ├─ components/      # секції та UI (Hero, Pricing, Quiz, LeadForm, ...)
│  ├─ layouts/         # Layout.astro (SEO, schema.org, аналітика)
│  ├─ pages/           # /, /case-bpla, /privacy, 404
│  ├─ data/            # site.ts (плейсхолдери), faq.ts
│  └─ styles/          # global.css (дизайн-токени @theme)
├─ public/             # favicon, og-default.png, robots.txt, /case (скрини)
├─ netlify/functions/  # submit.mjs — обробка форм → Telegram
└─ scripts/og.svg      # джерело OG-картинки
```

---

## 2. Плейсхолдери — замінити перед деплоєм

Усі контактні плейсхолдери зібрані в одному місці: **`src/data/site.ts`**.

| Що                     | Де                                   | Значення                          |
|------------------------|--------------------------------------|-----------------------------------|
| `[PHONE]`              | `site.phone`, `site.phoneDisplay`    | `+380XXXXXXXXX`                    |
| `[TG_LINK]`            | `site.telegram`                      | `https://t.me/...`                |
| Viber / WhatsApp       | `site.viber`, `site.whatsapp`        | номер                             |
| Email                  | `site.email`                         | пошта                             |
| Домен                  | `site.url` + `astro.config.mjs` `site` + `public/robots.txt` + `<Layout>` Plausible `data-domain` | реальний домен |
| `[TG_BOT_TOKEN]`       | env `TG_BOT_TOKEN` (не в коді)       | токен @BotFather                  |
| `[TG_CHAT_ID]`         | env `TG_CHAT_ID` (не в коді)         | id чату                           |
| Скрини демо-кейсу      | `public/case/`                       | покласти зображення, замінити заглушки |
| Фото юриста            | `src/components/Author.astro`        | замінити плейсхолдер               |

Після зміни домену онови також `data-domain` Plausible у `src/layouts/Layout.astro` і `Sitemap` URL у `public/robots.txt`.

---

## 3. Форми → Telegram

Форми (основна + квіз) шлють JSON на `/.netlify/functions/submit`, яка надсилає повідомлення у Telegram.

**Налаштування бота:**
1. Створи бота через [@BotFather](https://t.me/BotFather) → отримай `TG_BOT_TOKEN`.
2. Дізнайся `TG_CHAT_ID` (напиши боту, або через [@userinfobot](https://t.me/userinfobot); для каналу — id каналу, бота додати адміном).
3. У Netlify: **Site settings → Environment variables** додай `TG_BOT_TOKEN` і `TG_CHAT_ID`.

Якщо змінні не задані — заявка не втрачається, а логується у функції (див. Netlify Functions logs).

**Fallback (Formspree):** у `netlify/functions/submit.mjs` знизу є закоментований варіант — заміни `XXXXXXX` на id форми Formspree.

Захист від спаму: honeypot-поле + серверна валідація телефону `+380XXXXXXXXX`.

---

## 4. Деплой

### Netlify (основний)

Конфіг уже є — `netlify.toml` (`build = npm run build`, `publish = dist`, `functions = netlify/functions`).

1. Підключи репозиторій у Netlify (Astro у корені — Base directory не потрібен).
2. Додай env-змінні `TG_BOT_TOKEN`, `TG_CHAT_ID`, за потреби `SITE_URL`.
3. Deploy. Функція форм доступна на `/.netlify/functions/submit`.

Детальний покроковий гайд — у `DEPLOY.md`.

### Vercel

Astro статичний сайт деплоїться з коробки. Build: `npm run build`, Output: `dist`.
Netlify Function треба перенести у Vercel-формат: створи `api/submit.js` з `export default function handler(req, res)` (логіку скопіюй із `netlify/functions/submit.mjs`) і зміни у формах шлях `fetch` на `/api/submit`.

### GitHub Pages

Тільки статика (форми через Netlify Function працювати не будуть — використай Formspree або зовнішній endpoint).
1. У `astro.config.mjs` встав `site: 'https://<user>.github.io'` і, якщо репозиторій не кореневий, `base: '/<repo>/'`.
2. GitHub Action (`.github/workflows/`) з `withastro/action@v3`, або `npm run build` і публікація `dist/`.

---

## 5. Підключення домену

1. Netlify → **Domain settings → Add custom domain** → введи домен.
2. У реєстратора: `CNAME` на Netlify-адресу (або `A`/`ALIAS` за інструкцією Netlify).
3. Netlify автоматично видасть Let's Encrypt SSL.
4. Онови `site.url`, `astro.config.mjs` `site`, Plausible `data-domain`, `robots.txt`.

---

## 6. SEO та аналітика

- **Meta/OG/Twitter** — у `Layout.astro`, OG-картинка `public/og-default.png` (джерело `scripts/og.svg`, перегенерувати: `node -e "require('sharp')('scripts/og.svg').png().toFile('public/og-default.png')"`).
- **Schema.org** — `ProfessionalService` (усі сторінки), `FAQPage` + `Service` (головна).
- **Sitemap** — генерується автоматично (`sitemap-index.xml`), `/privacy` виключено.
- **robots.txt** — `public/robots.txt`.
- **Plausible** — підключено у `Layout.astro` (події: `submit_form`, `quiz_complete`, `click_telegram`, `click_phone`, `view_pricing` тощо). GA4 — закоментована опція там же.

---

## 7. Доступність та адаптив

- Mobile-first, брейкпоінти 360 / 744 / 1024 / 1440+, без горизонтального скролу.
- iOS: `100dvh`, `env(safe-area-inset-*)` для нижньої CTA-панелі, `-webkit-tap-highlight-color`.
- `@media (hover: hover)` для ховерів, `prefers-reduced-motion` вимикає анімації.
- Focus-visible кільця, `aria-expanded` на бургері й акордеоні, skip-link, labels у формах.

Перевірка брейкпоінтів: 375 / 768 / 1280 / 1920. Lighthouse (mobile): цілі Performance ≥ 95, Accessibility ≥ 95, SEO 100.
