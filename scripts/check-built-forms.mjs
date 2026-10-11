// Перевіряє у ЗІБРАНИХ сторінках, що поля форм мають maxlength із тих самих
// LEAD_LIMITS, за якими сервер відхиляє надто довгі значення (422). Запускати
// після `npm run build` (див. npm run verify і .github/workflows/ci.yml).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAD_LIMITS } from '../src/lib/lead-validation.js';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
if (!fs.existsSync(DIST)) {
  console.error('✗ Немає dist/ — спершу npm run build');
  process.exit(1);
}

function* htmlFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full);
    else if (entry.name.endsWith('.html')) yield full;
  }
}

const tagWith = (html, tag, marker) => {
  const re = new RegExp(`<${tag}\\b[^>]*${marker}[^>]*>`, 'g');
  return html.match(re) ?? [];
};
const maxlengthOf = (tagSrc) => {
  const m = tagSrc.match(/maxlength="?(\d+)"?/);
  return m ? Number(m[1]) : null;
};

let failures = 0;
let formPages = 0;
let quizPages = 0;
for (const file of htmlFiles(DIST)) {
  const html = fs.readFileSync(file, 'utf8');
  const rel = path.relative(DIST, file);

  // Основна форма запису (LeadForm): ім'я та ідея
  const hasLead = html.includes('id="lf-name"');
  if (hasLead) {
    formPages++;
    for (const [marker, tag, limit] of [['id="lf-name"', 'input', LEAD_LIMITS.name], ['id="lf-idea"', 'textarea', LEAD_LIMITS.idea]]) {
      const found = tagWith(html, tag, marker);
      const actual = found.length === 1 ? maxlengthOf(found[0]) : 'не знайдено';
      if (actual !== limit) {
        console.error(`✗ ${rel}: ${marker} maxlength=${actual}, очікувалось ${limit}`);
        failures++;
      }
    }
  }

  // Форма квізу: поле імені
  if (html.includes('data-quiz-form')) {
    quizPages++;
    const form = html.slice(html.indexOf('data-quiz-form'));
    const nameInput = (form.match(/<input\b[^>]*name="name"[^>]*>/) ?? [])[0];
    const actual = nameInput ? maxlengthOf(nameInput) : 'не знайдено';
    if (actual !== LEAD_LIMITS.name) {
      console.error(`✗ ${rel}: квіз, ім'я maxlength=${actual}, очікувалось ${LEAD_LIMITS.name}`);
      failures++;
    }
  }
}

if (formPages === 0) {
  console.error('✗ Не знайдено жодної сторінки з формою запису — перевірка нічого не перевірила');
  failures++;
}
console.log(failures ? `\n✗ Розбіжностей: ${failures}` : `✓ maxlength форм збігається з серверними межами (форм запису: ${formPages}, квізів: ${quizPages})`);
process.exit(failures ? 1 : 0);
