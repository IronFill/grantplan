// UTC Date represents Kyiv civil fields, never a visitor's local timezone.
export function kyivClock(instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(p => [p.type, p.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)));
}

export function minimumBookingDate(instant = new Date()) {
  const date = kyivClock(instant);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

export function validBooking(date, time, instant = new Date()) {
  if (!date && !time) return true;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})(?: \([^()]+\))?$/.exec(date);
  if (!match || !/^(1[0-7]):00$/.test(time)) return false;
  const [, day, month, year] = match.map(Number);
  const civil = new Date(Date.UTC(year, month - 1, day));
  return year >= 2026 && civil.getUTCFullYear() === year && civil.getUTCMonth() === month - 1 &&
    civil.getUTCDate() === day && civil.getUTCDay() !== 0 && civil >= minimumBookingDate(instant);
}
