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

## 3.1. Коментарі відвідувачів

Секція «Коментарі» (`src/components/Comments.astro`, унизу головної сторінки) — публічна форма з обов'язковими полями «Ім'я та прізвище» (сервер вимагає хоча б два слова) та «Email», і необов'язковим «Напрямок діяльності» (наприклад: кондитерська, СТО). Коментар публікується одразу, без модерації; **email ніколи не показується на сайті** — зберігається лише на бекенді, щоб можна було зв'язатися або відрізнити спам.

Бекенд на проді (Cloudflare Pages, `grantplan.com.ua`) — `functions/comments.js`, зберігання в **Workers KV** namespace `COMMENTS_KV` (уже створений і прив'язаний у Settings → Bindings проєкту). Є також парний варіант `netlify/functions/comments.mts` на **Netlify Blobs** — якщо колись повернетесь на Netlify, він спрацює без додаткових налаштувань.

- `GET /comments` — список коментарів (без email).
- `POST /comments` — новий коментар `{ name, business?, email, text }`.
- `DELETE /comments?id=...` — видалити спам-коментар; потрібен заголовок `X-Admin-Token`, що збігається з env `COMMENTS_ADMIN_TOKEN`. Якщо змінну не задати, видалення просто вимкнене (403) — жодного адмін-інтерфейсу немає, чистка вручну через `curl`:

  ```bash
  curl -X DELETE "https://ваш-домен/comments?id=ID_КОМЕНТАРЯ" -H "X-Admin-Token: ваш_токен"
  ```

Якщо задані `TG_BOT_TOKEN` / `TG_CHAT_ID` (ті самі, що для форми заявок) — про кожен новий коментар прилітає повідомлення в Telegram, щоб бачити спам одразу.

Захист від спаму: honeypot-поле, серверна валідація email і довжини тексту (5–1000 символів).

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
- **Plausible** — підключено у `Layout.astro` (події: `submit_form`, `quiz_complete`, `click_telegram`, `click_phone`, `view_pricing` тощо). GA4 — закоментована опція там же.

---

## 7. Доступність та адаптив

- Mobile-first, брейкпоінти 360 / 744 / 1024 / 1440+, без горизонтального скролу.
- iOS: `100dvh`, `env(safe-area-inset-*)` для нижньої CTA-панелі, `-webkit-tap-highlight-color`.
- `@media (hover: hover)` для ховерів, `prefers-reduced-motion` вимикає анімації.
- Focus-visible кільця, `aria-expanded` на бургері й акордеоні, skip-link, labels у формах.

Перевірка брейкпоінтів: 375 / 768 / 1280 / 1920. Lighthouse (mobile): цілі Performance ≥ 95, Accessibility ≥ 95, SEO 100.
