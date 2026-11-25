import { effectiveStatus, formatPeriod, kyivDate, STATUS } from './granty.js';

const TONE = {
  success: 'bg-success/10 text-success',
  accent: 'bg-accent/10 text-accent',
  muted: 'border border-border text-muted',
};

/** Оновлення статичного списку і прямої картки з однієї логіки. */
export function refreshGrantStatuses(root, today = kyivDate()) {
  for (const card of root.querySelectorAll('[data-grant-status]')) {
    const p = { status: card.dataset.status, period: {
      opens: card.dataset.opens || null, closes: card.dataset.closes || null,
    } };
    const status = effectiveStatus(p, today);
    const info = STATUS[status];
    if (!info) continue;
    card.dataset.effective = status;
    const badge = card.querySelector('[data-status-badge]');
    if (badge) {
      badge.textContent = info.label;
      badge.className = 'inline-flex items-center rounded-full px-2.5 py-1 font-medium ' + TONE[info.tone];
    }
    const period = card.querySelector('[data-grant-period]');
    if (period) period.textContent = formatPeriod(p, today) || '';
    const closed = card.querySelector('[data-grant-closed]');
    if (closed) closed.hidden = status !== 'closed';
    const unverified = card.querySelector('[data-grant-unverified]');
    if (unverified) unverified.hidden = status === 'closed';
  }
}
