/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** GA4 Measurement ID (напр. G-XXXXXXX). Порожньо = GA4 не підключено. */
  readonly PUBLIC_GA4_ID?: string;
  /** Meta (Facebook) Pixel ID. Порожньо = Pixel не підключено. */
  readonly PUBLIC_META_PIXEL_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
