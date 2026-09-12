// Єдине джерело цін. До цього одна й та сама сума була прописана руками у
// восьми місцях (тарифи, FAQ, пам'ятка консультанта, обидві сторінки умов
// співпраці, блок довіри, ROI-розрахунок у квізі) — і кожне підвищення цін
// означало ризик, що клієнт побачить на сайті одну суму, а в документі іншу.
//
// Міняємо ціну тут — вона змінюється всюди. Формат сум єдиний: нерозривний
// пробіл між тисячами, щоб число не переносилось на два рядки.

export interface Tier {
  /** Технічний ключ тарифу. */
  id: 'audit' | 'plan' | 'turnkey';
  min: number;
  max: number;
  /** Готовий рядок для показу: «5 000–7 000 ₴». */
  label: string;
  /** Строк виконання словами — теж дублювався по сайту. */
  term: string;
}

const nbsp = ' ';

/** «5000» → «5 000» (з нерозривним пробілом). */
export function uah(n: number): string {
  return n.toLocaleString('uk-UA').replace(/[\s ,]/g, nbsp) + `${nbsp}₴`;
}

export const tiers: Record<Tier['id'], Tier> = {
  audit: { id: 'audit', min: 0, max: 0, label: 'Безкоштовно', term: 'до 20 хв' },
  plan: {
    id: 'plan',
    min: 5_000,
    max: 7_000,
    label: `5${nbsp}000–7${nbsp}000${nbsp}₴`,
    term: '2–3 робочі дні',
  },
  turnkey: {
    id: 'turnkey',
    min: 10_000,
    max: 12_000,
    label: `10${nbsp}000–12${nbsp}000${nbsp}₴`,
    term: '4–7 робочих днів',
  },
};

/** Доопрацювання плану після відмови — окрема послуга, не тариф. */
export const rework = { min: 2_500, label: `від 2${nbsp}500${nbsp}₴` };

/** Щомісячний супровід після отримання гранту — окрема послуга, не тариф. */
export const support = { monthly: 2_500, label: `від 2${nbsp}500${nbsp}₴/міс` };

/** Найдорожчий варіант співпраці — орієнтир для порівнянь на кшталт ROI у квізі. */
export const maxServicePrice = tiers.turnkey.max;

/** Діапазон «від найдешевшого платного до найдорожчого» — для блоків довіри. */
export const fullRangeLabel = `${tiers.plan.min.toLocaleString('uk-UA').replace(/[\s ,]/g, nbsp)}${nbsp}–${nbsp}${uah(tiers.turnkey.max)}`;
