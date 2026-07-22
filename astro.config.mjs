// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// Замените на реальный домен перед деплоем (см. README).
const SITE = process.env.SITE_URL || 'https://grantplan.com.ua';

export default defineConfig({
  site: SITE,
  output: 'static',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/privacy') && !page.includes('/pamyatka'),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
