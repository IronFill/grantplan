// Перевірка внутрішніх посилань у зібраному сайті (dist/).
// Ловить друкарські помилки в href і сторінки, видалені без оновлення посилань —
// на статичному сайті це єдиний тип «404», який можна впіймати до деплою.
// Запуск: node scripts/check-links.mjs   (виконується в CI після build)

import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';

if (!fs.existsSync(DIST)) {
  console.error(`✗ Немає теки ${DIST}/ — спершу виконайте npm run build`);
  process.exit(1);
}

/** Рекурсивно збирає всі файли у теці. */
function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

const pages = [];
const assets = new Set();
walk(DIST, (file) => {
  if (file.endsWith('.html')) pages.push(file);
  assets.add('/' + path.relative(DIST, file).split(path.sep).join('/'));
});

// Маршрути: /about/index.html -> /about, /index.html -> /
const routes = new Set(
  pages.map((p) => {
    const rel = path.relative(DIST, p).split(path.sep).join('/');
    const route = '/' + rel.replace(/index\.html$/, '').replace(/\.html$/, '').replace(/\/$/, '');
    return route === '' ? '/' : route;
  })
);

const EXTERNAL = /^(https?:|mailto:|tel:|viber:|data:|#)/;
const broken = [];

for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (EXTERNAL.test(href)) continue;
    const clean = href.split('#')[0].split('?')[0].replace(/\/$/, '') || '/';
    if (routes.has(clean) || assets.has(clean) || assets.has(href)) continue;
    broken.push(`  ${path.relative(DIST, page)} → ${href}`);
  }
}

if (broken.length) {
  console.error(`✗ Знайдено биті внутрішні посилання (${broken.length}):`);
  console.error(broken.join('\n'));
  process.exit(1);
}

console.log(`✓ Внутрішні посилання цілі (перевірено ${pages.length} сторінок)`);
