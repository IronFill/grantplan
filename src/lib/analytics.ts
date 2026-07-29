// Спільна аналітика для всього сайту.
//
// Plausible лишається завжди активним — він не використовує cookies,
// тому не потребує згоди. GA4 і Meta Pixel використовують cookies,
// тож вантажаться лише після явної згоди у CookieConsent.astro, і лише
// якщо для них узагалі задані ID (порожні PUBLIC_GA4_ID/PUBLIC_META_PIXEL_ID
// означають "не підключено" — нічого зайвого не вантажимо).
//
// trackEvent() — єдина точка входу для подій: летить у всі три системи,
// які на разі активні, тож компонентам не треба знати, яка аналітика зараз увімкнена.

export const GA4_ID = import.meta.env.PUBLIC_GA4_ID ?? '';
export const META_PIXEL_ID = import.meta.env.PUBLIC_META_PIXEL_ID ?? '';

const CONSENT_KEY = 'gp_cookie_consent';
export type Consent = 'granted' | 'denied';

declare global {
  interface Window {
    plausible?: (name: string, opts?: { props?: Record<string, unknown> }) => void;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[]; callMethod?: (...args: unknown[]) => void };
    _fbq?: unknown;
  }
}

export function getConsent(): Consent | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

export function setConsent(value: Consent) {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // приватний режим без localStorage — банер просто питатиме щоразу, це не критично
  }
}

let loaded = false;

/** Вантажить GA4/Meta Pixel. Викликати лише після згоди користувача. */
export function loadConsentedAnalytics() {
  if (loaded || (!GA4_ID && !META_PIXEL_ID)) return;
  loaded = true;

  if (GA4_ID) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`;
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer!.push(args);
    };
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID);
  }

  if (META_PIXEL_ID) {
    const n: Window['fbq'] = function (...args: unknown[]) {
      if (n!.callMethod) n!.callMethod(...args);
      else n!.queue!.push(args);
    } as Window['fbq'];
    n!.queue = [];
    window.fbq = n;
    window._fbq = n;

    const t = document.createElement('script');
    t.async = true;
    t.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(t);

    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }
}

/** Викликати на кожній сторінці: якщо згода вже збережена з минулого разу — вантажимо одразу. */
export function initAnalyticsFromStoredConsent() {
  if (getConsent() === 'granted') loadConsentedAnalytics();
}

/** Єдина точка для подій — летить у Plausible завжди, у GA4/Meta лише якщо вони активні. */
export function trackEvent(name: string, props?: Record<string, unknown>) {
  window.plausible?.(name, props ? { props } : undefined);
  window.gtag?.('event', name, props ?? {});
  window.fbq?.('trackCustom', name, props ?? {});
}
