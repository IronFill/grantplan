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

### Перевірки перед пушем

```bash
npm run verify     # типи + тести + збірка + биті посилання (усе разом)
```

Окремо, якщо потрібно:

```bash
npm run check        # astro check — типи й шаблони
npm test             # логіка бекенд-функцій (заявки, модерація коментарів)
npm run check:links  # биті внутрішні посилання у зібраному dist/
```

Ті самі перевірки виконує GitHub Actions (`.github/workflows/ci.yml`) на кожен пуш і PR у `main`. Це важливо, бо **Cloudflare Pages деплоїть кожен пуш у `main` автоматично** — без CI зламана збірка їхала б на живий сайт.

Тести бекенду не потребують `wrangler` чи мережі: сховище й Telegram API підмінюються заглушками (`scripts/test-*.mjs`).

Структура (Astro у корені репозиторію):

```
.
├─ src/
│  ├─ components/      # секції та UI (Hero, Pricing, Quiz, LeadForm, ...)
│  ├─ layouts/         # Layout.astro (SEO, schema.org, аналітика)
│  ├─ pages/           # /, /case-bpla, /privacy, 404
│  ├─ data/            # site.ts (плейсхолдери), faq.ts
│  └─ styles/          # global.css (дизайн-токени @theme)
├─ public/             # favicon, og-default.png, robots.txt, llms.txt, /case
├─ functions/          # Cloudflare Pages: submit.js, comments.js (прод)
├─ netlify/functions/  # Netlify: submit.mjs, comments.mts (запасний хостинг)
├─ .github/workflows/  # ci.yml — типи, тести, збірка, биті посилання
└─ scripts/            # og.svg, check-links.mjs, test-*.mjs
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

⚠️ **Якщо `TG_BOT_TOKEN` / `TG_CHAT_ID` не задані, функція повертає помилку 503**, і відвідувач бачить запасний шлях («напишіть у Telegram або зателефонуйте»). Раніше в цьому випадку поверталось `ok: true` — людина бачила «Заявку надіслано ✓», хоча заявка лишалась тільки в логах, які ніхто не читає. Тобто **недоналаштований деплой більше не з'їдає ліди мовчки** — але й перевірити змінні після кожного переїзду тепер обов'язково.

**Fallback (Formspree):** у `netlify/functions/submit.mjs` знизу є закоментований варіант — заміни `XXXXXXX` на id форми Formspree.

Захист від спаму: honeypot-поле, серверна валідація телефону `+380XXXXXXXXX`, ліміт **5 заявок на годину з однієї IP** (лічильник у тому ж KV, що й коментарі; без прив'язаного KV ліміт просто не застосовується — форма працює далі).

---

## 3.1. Коментарі відвідувачів

Секція «Коментарі» (`src/components/Comments.astro`, унизу головної сторінки) — публічна форма з обов'язковими полями «Ім'я та прізвище» (сервер вимагає хоча б два слова) та «Email», і необов'язковим «Напрямок діяльності» (наприклад: кондитерська, СТО). **Email ніколи не показується на сайті** — зберігається лише на бекенді, щоб можна було зв'язатися або відрізнити спам.

### Модерація (обов'язковий крок!)

Коментар **не з'являється на сайті одразу** — він лягає в чергу й публікується лише після явного схвалення. Без цього будь-хто міг миттєво опублікувати на сайті консультаційної практики рекламу конкурента, образу чи спам.

Щоб схвалення взагалі працювало, задайте env-змінну **`COMMENTS_ADMIN_TOKEN`** (Cloudflare Pages → Settings → Variables and secrets) — будь-який довгий випадковий рядок. Без неї коментарі накопичуватимуться в черзі, але опублікувати їх буде неможливо.

Бекенд на проді (Cloudflare Pages, `grantplan.com.ua`) — `functions/comments.js`, зберігання в **Workers KV** namespace `COMMENTS_KV` (уже створений і прив'язаний у Settings → Bindings проєкту). Є також парний варіант `netlify/functions/comments.mts` на **Netlify Blobs** — з такою самою модерацією.

- `GET /comments` — **схвалені** коментарі (без email).
- `POST /comments` — новий коментар `{ name, business?, email, text }` → потрапляє в чергу.
- `GET /comments?pending=1` — черга модерації; потрібен `X-Admin-Token`.
- `POST /comments?action=approve&id=...` — опублікувати коментар; потрібен `X-Admin-Token`.
- `DELETE /comments?id=...` — видалити (і з черги, і з опублікованих); потрібен `X-Admin-Token`.

Адмін-інтерфейсу немає — робота через `curl`:

```bash
# 1. Подивитись, що чекає на модерацію
curl "https://ваш-домен/comments?pending=1" -H "X-Admin-Token: ваш_токен"

# 2. Опублікувати конкретний коментар (id є у відповіді вище та в Telegram)
curl -X POST "https://ваш-домен/comments?action=approve&id=ID_КОМЕНТАРЯ" -H "X-Admin-Token: ваш_токен"

# 3. Або видалити спам
curl -X DELETE "https://ваш-домен/comments?id=ID_КОМЕНТАРЯ" -H "X-Admin-Token: ваш_токен"
```

Якщо задані `TG_BOT_TOKEN` / `TG_CHAT_ID` (ті самі, що для форми заявок) — про кожен новий коментар прилітає повідомлення в Telegram **разом з `id` для схвалення**, тож копіювати його з API не обов'язково.

Захист від спаму: honeypot-поле, серверна валідація email і довжини тексту (5–1000 символів), ліміт **3 коментарі на годину з однієї IP**, а нерозглянуті коментарі самознищуються через 90 днів.

Якщо піднімаєте проєкт на новому Cloudflare Pages акаунті — не забудьте створити KV namespace і прив'язати його як `COMMENTS_KV` (Settings → Bindings → Add → KV namespace). Без нього ендпоінт чесно повертає 503, а не вдає, що зберіг дані.

---

## 4. Деплой

### Cloudflare Pages (основний, поточний хостинг — grantplan.com.ua)

Проєкт перенесли з Netlify на Cloudflare Pages (у Netlify закінчились operational credits). Git-інтеграція з `IronFill/grantplan` вже налаштована — кожен пуш у `main` деплоїться автоматично.

1. Workers & Pages → проєкт `grantplan` → Settings → **Build configuration**: `npm run build`, output `dist`.
2. **Variables and secrets** → додай `TG_BOT_TOKEN`, `TG_CHAT_ID`.
3. **Bindings** → Add → **KV namespace** → змінна `COMMENTS_KV`, namespace `grantplan-comments` (потрібен для секції коментарів, див. розділ 3.1).
4. **Custom domains** → додай домен (детальніше в розділі 5 нижче).

Функції форм і коментарів доступні на `/submit` і `/comments` (файли в `functions/`).

### Netlify (альтернатива)

Конфіг лишився в репозиторії — `netlify.toml` (`build = npm run build`, `publish = dist`, `functions = netlify/functions`). Якщо колись знадобиться повернутись:

1. Підключи репозиторій у Netlify (Astro у корені — Base directory не потрібен).
2. Додай env-змінні `TG_BOT_TOKEN`, `TG_CHAT_ID`, за потреби `SITE_URL`.
3. Deploy. Функція форм доступна на `/.netlify/functions/submit`, коментарів — на `/.netlify/functions/comments` (Netlify Blobs, без додаткових налаштувань).

Детальний покроковий гайд (написаний ще під Netlify) — у `DEPLOY.md`.

### Vercel

Astro статичний сайт деплоїться з коробки. Build: `npm run build`, Output: `dist`.
Netlify Function треба перенести у Vercel-формат: створи `api/submit.js` з `export default function handler(req, res)` (логіку скопіюй із `netlify/functions/submit.mjs`) і зміни у формах шлях `fetch` на `/api/submit`.

### GitHub Pages

Тільки статика (форми через Netlify Function працювати не будуть — використай Formspree або зовнішній endpoint).
1. У `astro.config.mjs` встав `site: 'https://<user>.github.io'` і, якщо репозиторій не кореневий, `base: '/<repo>/'`.
2. GitHub Action (`.github/workflows/`) з `withastro/action@v3`, або `npm run build` і публікація `dist/`.

---

## 5. Підключення домену

Домен `grantplan.com.ua` уже підключений (реєстратор — ukraine.com.ua, панель на движку adm.tools). Кроки для повторення на новому домені/акаунті:

1. Cloudflare Dashboard → **Add a site → Connect a domain** → введи домен.
2. Якщо DNS-зона домену ще не на Cloudflare — крок **«Transfer DNS management»**: Cloudflare дає 2 nameserver'и, їх треба прописати в панелі реєстратора домену (розділ «Нейм-сервери (NS)» або аналогічний) замість поточних. Активація зазвичай займає від кількох хвилин до 24 год.
3. Коли зона стане **Active** — Workers & Pages → проєкт `grantplan` → **Custom domains** → **Set up a custom domain** → той самий домен. Cloudflare сам створить потрібний DNS-запис і випустить SSL.
4. Онови `site.url` (`src/data/site.ts`), `astro.config.mjs` `SITE_URL`, Plausible `data-domain` (`Layout.astro`), `robots.txt`.

---

## 6. SEO та аналітика

- **Meta/OG/Twitter** — у `Layout.astro`, OG-картинка `public/og-default.png` (джерело `scripts/og.svg`, перегенерувати: `node -e "require('sharp')('scripts/og.svg').png().toFile('public/og-default.png')"`).
- **Schema.org** — `ProfessionalService` (усі сторінки), `FAQPage` + `Service` (головна).
- **Sitemap** — генерується автоматично (`sitemap-index.xml`), `/privacy` виключено.
- **robots.txt** — `public/robots.txt`.
- **Plausible** — підключено у `Layout.astro`, без cookies, працює завжди (згода не потрібна).

### GA4 / Meta Pixel / cookie-згода

Спільна логіка — `src/lib/analytics.ts`:

- `trackEvent(name, props?)` — єдина точка для подій (`submit_form`, `quiz_complete`, `click_telegram`, `click_phone`, `view_pricing`, `toggle_theme` тощо). Летить у Plausible завжди, у GA4/Meta — лише якщо вони активні.
- Клацання на будь-якому елементі з `data-analytics="назва_події"` відстежуються централізовано в `Layout.astro` (один делегований слухач на весь сайт, а не дублікат у кожному компоненті).

**Підключення GA4/Meta:** задай env-змінні `PUBLIC_GA4_ID` (напр. `G-XXXXXXX`) і/або `PUBLIC_META_PIXEL_ID` у Cloudflare Pages → Settings → Variables and secrets, і передеплой. Якщо змінна порожня — відповідний скрипт узагалі не потрапляє в збірку (перевірено: порожні ID повністю вирізаються зі сборки, не просто не викликаються).

GA4 на проді вже підключено (`PUBLIC_GA4_ID` заданий у Cloudflare Pages). Meta Pixel — поки ні, додати аналогічно через `PUBLIC_META_PIXEL_ID`, коли буде готовий Business Manager.

**Cookie-банер** (`src/components/CookieConsent.astro`, підключений глобально в `Layout.astro`) — показується, поки немає збереженого рішення в `localStorage` (`gp_cookie_consent`). GA4/Meta вантажаться лише після «Прийняти»; «Тільки необхідні» — сайт працює далі, ці сервіси не активуються. Рішення користувача не впливає на Plausible.

---

## 7. Доступність та адаптив

- Mobile-first, брейкпоінти 360 / 744 / 1024 / 1440+, без горизонтального скролу.
- iOS: `100dvh`, `env(safe-area-inset-*)` для нижньої CTA-панелі, `-webkit-tap-highlight-color`.
- `@media (hover: hover)` для ховерів, `prefers-reduced-motion` вимикає анімації.
- Focus-visible кільця, `aria-expanded` на бургері й акордеоні, skip-link, labels у формах.

Перевірка брейкпоінтів: 375 / 768 / 1280 / 1920. Lighthouse (mobile): цілі Performance ≥ 95, Accessibility ≥ 95, SEO 100.
