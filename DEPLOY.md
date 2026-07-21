# Деплой «ГрантПлан» на Netlify

Проєкт — окремий репозиторій (`ironfill/grantplan`), Astro лежить у корені. Форми обробляє Netlify Function (`netlify/functions/submit.mjs`), яка надсилає заявки в Telegram.

---

## Варіант A. Через Git (рекомендовано — авто-деплой при пуші)

### 1. Підготувати Telegram-бота (для форми)

1. У [@BotFather](https://t.me/BotFather) → `/newbot` → отримати **`TG_BOT_TOKEN`**.
2. Дізнатися **`TG_CHAT_ID`**: напишіть своєму боту, потім відкрийте [@userinfobot](https://t.me/userinfobot) (для особистого чату). Для каналу — додайте бота адміном і візьміть id каналу.

### 2. Створити сайт у Netlify

Netlify → **Add new site → Import an existing project** → **GitHub** → вибрати репозиторій `ironfill/grantplan`.

### 3. Налаштування збірки

Astro у корені репозиторію, тож Base directory **не потрібен**. Netlify сам визначить фреймворк, а `netlify.toml` у корені задасть решту:

| Поле | Значення |
| --- | --- |
| **Build command** | `npm run build` |
| **Publish directory** | `dist` |
| **Functions directory** | `netlify/functions` |

> У корені репозиторію є `netlify.toml` — Netlify читає його й підставляє build / publish / functions і Node 20 автоматично.

### 4. Змінні оточення

Site configuration → **Environment variables** → додати:

- `TG_BOT_TOKEN` — токен бота
- `TG_CHAT_ID` — id чату
- (опц.) `SITE_URL` — фінальний домен, напр. `https://grantplan.com.ua`

### 5. Гілка для деплою

Продакшн-гілка — `main` (за замовчуванням). Кожен пуш у `main` авто-передеплоює сайт.

### 6. Deploy

**Deploy site**. Функція форми буде доступна на `/.netlify/functions/submit`.

### 7. Домен

- **Domain management → Add a custom domain** → ввести домен → у реєстратора прописати CNAME/записи за підказкою Netlify → SSL видається автоматично.
- Після зміни домену оновіть у коді: `src/data/site.ts` (`url`), `astro.config.mjs` (`site`), `public/robots.txt` і `data-domain` Plausible у `src/layouts/Layout.astro`.

### 8. Перевірка

Надішліть тестову заявку через форму → має прийти повідомлення в Telegram.

---

## Варіант B. Через Netlify CLI (ручний деплой)

```bash
npm install -g netlify-cli
netlify login
netlify init          # привʼязати/створити сайт
netlify env:set TG_BOT_TOKEN "СЮДИ_ТОКЕН"
netlify env:set TG_CHAT_ID "СЮДИ_CHAT_ID"
netlify deploy --build --prod   # збере і задеплоїть із функціями
```

CLI запускається з кореня репозиторію, `netlify.toml` поруч підхопиться автоматично.

---

## Якщо токенів Telegram ще немає

Сайт усе одно задеплоїться, і заявки не загубляться: функція логуватиме їх у **Functions logs**, поки змінні не задані. Пізніше додасте `TG_BOT_TOKEN` / `TG_CHAT_ID` і передеплоїте.

## Fallback без Netlify Functions (Formspree)

Якщо не хочете піднімати функцію (напр. деплой на GitHub Pages) — у `netlify/functions/submit.mjs` знизу є закоментований варіант через [Formspree](https://formspree.io): замініть `XXXXXXX` на id вашої форми, а у формах (`LeadForm.astro`, `Quiz.astro`) — шлях `fetch` на URL Formspree.

---

Коротка версія цих кроків також є в `README.md` (розділи «Форми → Telegram» і «Деплой»).
