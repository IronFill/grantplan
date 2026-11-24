// Каталог грантів: чиста логіка без залежностей від Astro, щоб її можна було
// перевірити тестом (scripts/test-granty.mjs) і використати в браузері.
//
// Дані — src/data/granty.json. Файл створюється експортом з ПРИВАТНОЇ бази
// (репозиторій grantplan-granty, skrypty/eksport-publichnyh.mjs) і містить лише
// безкоштовні поля. Платні поля (надбавки, витрати, порядок подання) сюди
// потрапляти не повинні: репозиторій відкритий. Це перевіряє test-granty.mjs.

export const STATUS = {
  open: { label: 'Приймають заявки', tone: 'success', rank: 0 },
  rolling: { label: 'Приймають постійно', tone: 'success', rank: 1 },
  expected: { label: 'Очікується набір', tone: 'accent', rank: 2 },
  unknown: { label: 'Статус уточнюється', tone: 'muted', rank: 3 },
  closed: { label: 'Закрито', tone: 'muted', rank: 4 },
};

export const KIND = {
  grant: { label: 'Грант', filter: 'Гранти' },
  loan: { label: 'Пільговий кредит', filter: 'Кредити' },
  compensation: { label: 'Компенсація', filter: 'Компенсації' },
  support: { label: 'Підтримка', filter: 'Навчання, гарантії, страхування' },
};

export const ENTITY = {
  individual: 'Фізична особа, яка ще планує бізнес',
  fop: 'ФОП',
  llc: 'ТОВ та інші юрособи',
  self_employed: 'Самозайнятий',
  farm: 'Фермерське господарство',
  ngo: 'Громадська організація',
};

export const CATEGORY = {
  any: 'Без обмежень за статусом',
  veteran: 'Ветерани',
  veteran_family: 'Члени родин ветеранів',
  veteran_friendly: 'Бізнес, де працюють ветерани',
  combatant: 'Учасники бойових дій',
  vpo: 'ВПО',
  youth: 'Молодь',
  youth_18_25: 'Молодь 18–25 років',
  women: 'Жінки',
  disability: 'Люди з інвалідністю',
};

/** Що вибирає людина у фільтрі «Хто ви за статусом» і які категорії карточок це означає. */
export const CATEGORY_GROUPS = {
  veteran: { label: 'Ветеран або член родини', members: ['veteran', 'veteran_family', 'veteran_friendly', 'combatant'] },
  vpo: { label: 'ВПО', members: ['vpo'] },
  youth: { label: 'Молодь до 25 років', members: ['youth', 'youth_18_25'] },
  women: { label: 'Жінка-підприємиця', members: ['women'] },
  disability: { label: 'Людина з інвалідністю', members: ['disability'] },
};

export const ENTITY_FILTER = {
  fop: { label: 'ФОП', members: ['fop', 'self_employed'] },
  llc: { label: 'ТОВ або інша юрособа', members: ['llc'] },
  individual: { label: 'Ще без бізнесу, фізособа', members: ['individual'] },
  farm: { label: 'Фермерське господарство', members: ['farm'] },
};

const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const CURRENCY = { UAH: 'грн', EUR: 'євро', USD: 'дол. США' };

/** Статус на задану дату: відкрита програма з минулим дедлайном вважається закритою. */
export function effectiveStatus(p, today) {
  if ((p.status === 'open' || p.status === 'rolling') && p.period?.closes && p.period.closes < today) return 'closed';
  return p.status;
}

export function formatNumber(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Рядок про суму або null, якщо суми немає. */
export function formatAmount(p) {
  const a = p.amount ?? {};
  const cur = CURRENCY[a.currency] ?? a.currency ?? '';
  const unit = cur ? ` ${cur}` : '';
  let text = null;
  if (a.min != null && a.max != null && a.min !== a.max) text = `від ${formatNumber(a.min)} до ${formatNumber(a.max)}${unit}`;
  else if (a.max != null) text = `до ${formatNumber(a.max)}${unit}`;
  else if (a.min != null) text = `від ${formatNumber(a.min)}${unit}`;
  if (text && a.cap != null && a.cap !== a.max) text += `, з надбавками до ${formatNumber(a.cap)}${unit}`;
  return text;
}

/** Рядок про строки прийому або null. */
export function formatPeriod(p, today) {
  const { opens, closes } = p.period ?? {};
  const status = effectiveStatus(p, today);
  if (status === 'closed') return closes ? `Прийом завершено ${formatDate(closes)}` : 'Прийом завершено';
  if (closes) return `Приймають до ${formatDate(closes)}`;
  if (opens) return `Прийом з ${formatDate(opens)}`;
  return null;
}

export function sortPrograms(programs, today) {
  return [...programs].sort((a, b) => {
    const ra = STATUS[effectiveStatus(a, today)]?.rank ?? 9;
    const rb = STATUS[effectiveStatus(b, today)]?.rank ?? 9;
    if (ra !== rb) return ra - rb;
    const ca = a.period?.closes ?? '9999-99-99';
    const cb = b.period?.closes ?? '9999-99-99';
    if (ra === 4) return cb.localeCompare(ca) || a.title.localeCompare(b.title, 'uk');
    return ca.localeCompare(cb) || a.title.localeCompare(b.title, 'uk');
  });
}

/**
 * Чи підходить програма під вибір людини.
 * filters: { who, cat, kind, showClosed, q }. Порожнє значення означає «не важливо».
 * Програма «без обмежень за статусом» (any) підходить і ветерану, і ВПО, і молоді.
 */
export function matches(p, filters, today) {
  const f = filters ?? {};
  if (!f.showClosed && effectiveStatus(p, today) === 'closed') return false;
  if (f.who) {
    const members = ENTITY_FILTER[f.who]?.members ?? [f.who];
    if (!p.entities.some((e) => members.includes(e))) return false;
  }
  if (f.cat) {
    const members = CATEGORY_GROUPS[f.cat]?.members ?? [f.cat];
    if (!p.categories.some((c) => c === 'any' || members.includes(c))) return false;
  }
  if (f.kind && p.kind !== f.kind) return false;
  const q = (f.q ?? '').trim().toLowerCase();
  if (q) {
    const hay = `${p.title} ${p.short} ${p.operator?.name ?? ''}`.toLowerCase();
    if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

/** Категорії карточки для показу: без службового «any». */
export function visibleCategories(p) {
  return p.categories.filter((c) => c !== 'any').map((c) => CATEGORY[c] ?? c);
}

export function visibleEntities(p) {
  return p.entities.map((e) => ENTITY[e] ?? e);
}

export function visibleRegions(p) {
  return p.regions.filter((r) => r !== 'all');
}

export function visibleSectors(p) {
  return p.sectors.filter((s) => s !== 'any');
}
