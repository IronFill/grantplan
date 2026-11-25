// Тест каталогу грантів: логіка фільтрів і, головне, захист платних даних.
// Публічний репозиторій відкритий, тому src/data/granty.json має містити ЛИШЕ безкоштовні поля.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  effectiveStatus, formatAmount, formatPeriod, formatDate, formatNumber, matches, sortPrograms, visibleCategories, visibleEntities, kyivDate, STATUS,
} from '../src/lib/granty.js';
import { refreshGrantStatuses } from '../src/lib/granty-status.js';

const raw = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../src/data/granty.json', import.meta.url)), 'utf8'));
const programs = raw.programs;
const TODAY = '2026-11-24';

// ---------- 1. Дані: лише дозволені поля ----------
const ALLOWED_TOP = ['id', 'title', 'short', 'operator', 'kind', 'source_type', 'status', 'period', 'last_checked', 'amount',
  'entities', 'categories', 'regions', 'sectors', 'verified', 'replaced_by'];
const ALLOWED_NESTED = { operator: ['name', 'url'], period: ['opens', 'closes'], amount: ['min', 'max', 'cap', 'currency'] };
const FORBIDDEN = ['bonuses', 'costs', 'obligations', 'process', 'paid', 'sources', 'cofinancing', 'unverified', 'summary', 'excluded_activities', 'pitfalls', 'tips', 'note'];

assert.ok(programs.length >= 1, 'порожній каталог');
const ids = new Set();
for (const p of programs) {
  assert.deepEqual(Object.keys(p).sort(), [...ALLOWED_TOP].sort(), `${p.id}: набір полів відрізняється від дозволеного`);
  for (const [key, allowed] of Object.entries(ALLOWED_NESTED)) {
    assert.deepEqual(Object.keys(p[key]).sort(), [...allowed].sort(), `${p.id}.${key}: зайві поля`);
  }
  assert.match(p.id, /^[a-z0-9][a-z0-9-]*$/, `${p.id}: id для адреси`);
  assert.ok(!ids.has(p.id), `повторний id ${p.id}`);
  ids.add(p.id);
  assert.ok(STATUS[p.status], `${p.id}: невідомий статус ${p.status}`);
  assert.ok(p.title && p.short, `${p.id}: немає назви чи опису`);
  assert.ok(!/—/.test(JSON.stringify(p)), `${p.id}: довге тире`);
}
const walk = (value, path) => {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(!FORBIDDEN.includes(k), `платне поле «${k}» у публічних даних: ${path}`);
      walk(v, `${path}.${k}`);
    }
  }
};
walk(raw, 'granty.json');
for (const p of programs) if (p.replaced_by) assert.ok(ids.has(p.replaced_by), `${p.id}: replaced_by вказує на неіснуючу програму`);

// ---------- 2. Статус на дату ----------
const base = { status: 'open', period: { opens: null, closes: '2026-12-02' } };
assert.equal(effectiveStatus(base, '2026-12-02'), 'open', 'у день дедлайну ще відкрито');
assert.equal(effectiveStatus(base, '2026-12-03'), 'closed');
assert.equal(effectiveStatus({ ...base, status: 'rolling' }, '2027-01-01'), 'closed');
assert.equal(effectiveStatus({ ...base, status: 'unknown' }, '2027-01-01'), 'unknown');
assert.equal(effectiveStatus({ status: 'rolling', period: { closes: null } }, '2030-01-01'), 'rolling');

// Межа календарного дедлайну визначається в Києві, не за UTC/локаллю читача.
assert.equal(kyivDate(new Date('2026-12-02T21:59:59Z')), '2026-12-02');
assert.equal(kyivDate(new Date('2026-12-02T22:00:00Z')), '2026-12-03');
assert.equal(kyivDate(new Date('2026-12-02T17:00:00-05:00')), '2026-12-03');
assert.equal(kyivDate(new Date('2026-07-01T21:00:00Z')), '2026-07-02', 'літній час Києва');

// Реальна програма: виправлення лише публічних полів, без вигаданого часу закриття.
const youth = programs.find((p) => p.id === 'granty-prezydenta-molod');
assert.ok(youth);
assert.deepEqual(youth.period, { opens: '2026-11-02', closes: '2026-12-02' });
assert.equal(youth.amount.min, 50000);
assert.equal(youth.amount.max, 200000);
assert.equal(youth.operator.url, 'https://uyf.gov.ua/programs/hranty-prezydenta-2027');
assert.equal(formatPeriod(youth, '2026-11-25'), 'Прийом з 2 листопада 2026 до 2 грудня 2026');
assert.match(youth.short, /Суспільно важливі молодіжні проєкти/);
assert.match(youth.short, /01\.08\.2027/);
assert.equal(visibleEntities(youth).some((s) => s.includes('планує бізнес')), false);
assert.match(visibleEntities(youth).join(' '), /14–35/);
assert.equal(matches(youth, { who: 'individual', cat: 'youth' }, '2026-12-02'), true);
assert.equal(matches(youth, {}, '2026-12-03'), false, 'після дедлайну прихована у списку');
assert.equal(matches(youth, { showClosed: true }, '2026-12-03'), true);

// DOM-контракт списку і прямої сторінки: старий HTML оновлює не лише бейдж,
// а й текст строку/повідомлення. Інша відкрита програма зберігає свій статус.
function statusCard(status, closes, detail = false) {
  const elements = new Map(['[data-status-badge]', '[data-grant-period]', '[data-grant-unverified]'].map((s) => [s, { textContent: '', className: '', hidden: false }]));
  if (detail) elements.set('[data-grant-closed]', { hidden: true });
  return { dataset: { status, closes }, querySelector: (s) => elements.get(s), elements };
}
for (const detail of [false, true]) {
  const card = statusCard('open', youth.period.closes, detail);
  const other = statusCard('open', '2027-02-01', detail);
  const root = { querySelectorAll: () => [card, other] };
  refreshGrantStatuses(root, kyivDate(new Date('2026-12-02T21:59:59Z')));
  assert.equal(card.elements.get('[data-status-badge]').textContent, 'Приймають заявки');
  refreshGrantStatuses(root, kyivDate(new Date('2026-12-02T22:00:00Z')));
  assert.equal(card.dataset.effective, 'closed');
  assert.equal(card.elements.get('[data-status-badge]').textContent, 'Закрито');
  assert.equal(card.elements.get('[data-grant-period]').textContent, 'Прийом завершено 2 грудня 2026');
  assert.equal(card.elements.get('[data-grant-unverified]').hidden, true);
  if (detail) assert.equal(card.elements.get('[data-grant-closed]').hidden, false);
  assert.equal(other.dataset.effective, 'open');
  assert.equal(other.elements.get('[data-status-badge]').textContent, 'Приймають заявки');
}

// ---------- 3. Форматування ----------
const nb = ' ';
assert.equal(formatNumber(1500000), `1${nb}500${nb}000`);
assert.equal(formatDate('2026-08-14'), '14 серпня 2026');
assert.equal(formatDate(null), '');
assert.equal(formatAmount({ amount: { min: 100000, max: 300000, cap: 500000, currency: 'UAH' } }),
  `від 100${nb}000 до 300${nb}000${nb}грн, з надбавками до 500${nb}000${nb}грн`);
assert.equal(formatAmount({ amount: { min: null, max: 20000, cap: null, currency: 'EUR' } }), `до 20${nb}000${nb}євро`);
assert.equal(formatAmount({ amount: { min: null, max: null, cap: null, currency: 'UAH' } }), null);
assert.equal(formatPeriod({ status: 'open', period: { opens: null, closes: '2026-12-02' } }, TODAY), 'Приймають до 2 грудня 2026');
assert.equal(formatPeriod({ status: 'open', period: { opens: null, closes: '2026-11-01' } }, TODAY), 'Прийом завершено 1 листопада 2026');
assert.equal(formatPeriod({ status: 'rolling', period: { opens: null, closes: null } }, TODAY), null);

// ---------- 4. Фільтри ----------
const mk = (over) => ({ id: 'x', title: 'Назва', short: 'Опис', operator: { name: 'Оператор' }, kind: 'grant', status: 'rolling',
  period: { opens: null, closes: null }, entities: ['fop'], categories: ['any'], ...over });
const closed = mk({ status: 'closed' });
assert.equal(matches(closed, {}, TODAY), false, 'закриті приховані за замовчуванням');
assert.equal(matches(closed, { showClosed: true }, TODAY), true);
assert.equal(matches(mk({}), { who: 'fop' }, TODAY), true);
assert.equal(matches(mk({ entities: ['llc'] }), { who: 'fop' }, TODAY), false);
assert.equal(matches(mk({ entities: ['self_employed'] }), { who: 'fop' }, TODAY), true, 'самозайнятий входить у групу ФОП');
assert.equal(matches(mk({ categories: ['any'] }), { cat: 'veteran' }, TODAY), true, 'програма для всіх підходить і ветерану');
assert.equal(matches(mk({ categories: ['women'] }), { cat: 'veteran' }, TODAY), false);
assert.equal(matches(mk({ categories: ['veteran_family'] }), { cat: 'veteran' }, TODAY), true);
assert.equal(matches(mk({ kind: 'loan' }), { kind: 'grant' }, TODAY), false);
assert.equal(matches(mk({ title: 'Ваучер на навчання' }), { q: 'ваучер навчання' }, TODAY), true);
assert.equal(matches(mk({ title: 'Ваучер на навчання' }), { q: 'теплиця' }, TODAY), false);
assert.deepEqual(visibleCategories(mk({ categories: ['any', 'vpo'] })), ['ВПО']);

// ---------- 5. Порядок ----------
const sorted = sortPrograms([
  mk({ id: 'c', title: 'Я', status: 'closed', period: { closes: '2026-03-01' } }),
  mk({ id: 'u', title: 'Б', status: 'unknown' }),
  mk({ id: 'o2', title: 'А', status: 'open', period: { closes: '2026-12-20' } }),
  mk({ id: 'o1', title: 'А', status: 'open', period: { closes: '2026-12-02' } }),
  mk({ id: 'r', title: 'В', status: 'rolling' }),
], TODAY).map((p) => p.id);
assert.deepEqual(sorted, ['o1', 'o2', 'r', 'u', 'c']);

// ---------- 6. Реальні дані проходять через фільтри ----------
const open = programs.filter((p) => ['open', 'rolling'].includes(effectiveStatus(p, TODAY)));
assert.ok(open.length >= 1, 'у каталозі немає жодної відкритої програми');
for (const f of [{ who: 'fop' }, { who: 'llc' }, { cat: 'veteran' }, { cat: 'vpo' }, { cat: 'youth' }, { cat: 'women' }, { kind: 'loan' }]) {
  assert.ok(programs.filter((p) => matches(p, { ...f, showClosed: true }, TODAY)).length >= 1, `фільтр ${JSON.stringify(f)} нічого не повертає`);
}

console.log(`OK: каталог грантів, ${programs.length} програм, платних полів у публічних даних немає`);
