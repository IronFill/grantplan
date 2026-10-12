// Validate emitted HTML, not source templates. Run after the static build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.argv[2] || fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'https://grantplan.com.ua';
const errors = [];
const titles = new Map();
const descriptionsSeen = new Map();
const routes = new Map();
const sitemapUrls = new Set();
const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else yield full;
  }
}
if (!fs.existsSync(dist)) throw new Error('Missing build directory; run npm run build first.');
for (const file of files(dist)) {
  const relative = path.relative(dist, file).split(path.sep).join('/');
  if (/^sitemap.*\.xml$/.test(relative)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/<loc>(.*?)<\/loc>/g)) {
      const url = decode(m[1]);
      if (!url.endsWith('.xml')) sitemapUrls.add(url);
    }
  }
  if (!file.endsWith('.html')) continue;
  const route = '/' + relative.replace(/index\.html$/, '').replace(/\.html$/, '').replace(/\/$/, '');
  const html = fs.readFileSync(file, 'utf8');
  const metas = [...html.matchAll(/<meta\b[^>]*>/g)].map(m => attrs(m[0]));
  const canonicalTags = [...html.matchAll(/<link\b[^>]*>/g)].map(m => attrs(m[0])).filter(a => a.rel === 'canonical');
  const canonical = canonicalTags[0]?.href;
  const noindex = metas.some(a => a.name === 'robots' && /\bnoindex\b/.test(a.content || ''));
  routes.set(route || '/', { html, file, canonical, noindex });
  const fail = message => errors.push(`${relative}: ${message}`);
  if (html.includes('\uFFFD')) fail('damaged UTF-8 text');
  if (!/<html\b[^>]*\blang="uk"/.test(html)) fail('missing Ukrainian document language');
  const pageTitles = [...html.matchAll(/<title>(.*?)<\/title>/gs)];
  const title = decode(pageTitles[0]?.[1] || '').trim();
  if (pageTitles.length !== 1 || !title) fail('expected one non-empty title');
  if (!noindex && title) {
    if (titles.has(title)) fail(`duplicate title also used by ${titles.get(title)}`);
    titles.set(title, relative);
  }
  if ([...html.matchAll(/<h1\b/g)].length !== 1) fail('expected exactly one H1');
  const descriptions = metas.filter(a => a.name === 'description');
  if (descriptions.length !== 1 || !descriptions[0].content?.trim()) fail('expected one non-empty description');
  const description = descriptions[0]?.content?.trim() || '';
  if (title.length > 120) fail(`title is ${title.length} characters; this is far beyond what search results can show`);
  if (description && (description.length < 30 || description.length > 320)) fail(`description is ${description.length} characters; expected a real summary between 30 and 320`);
  if (!noindex && description) {
    if (descriptionsSeen.has(description)) fail(`duplicate description also used by ${descriptionsSeen.get(description)}`);
    descriptionsSeen.set(description, relative);
  }
  if (!noindex) {
    for (const property of ['og:title', 'og:description', 'og:image']) {
      if (!metas.some(a => a.property === property && a.content?.trim())) fail(`missing ${property}`);
    }
  }
  const expected = new URL((route || '/') + (route && !route.endsWith('/') ? '/' : ''), origin).href;
  if (canonicalTags.length !== 1 || canonical !== expected) fail(`canonical must be ${expected}`);
  for (const m of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { fail('invalid JSON-LD'); continue; }
    for (const item of [].concat(data)) {
      if (item?.['@type'] !== 'BreadcrumbList') continue;
      const list = item.itemListElement;
      if (!Array.isArray(list) || list.length < 2 || list.some(entry => !entry?.name || !entry?.item)) fail('BreadcrumbList needs at least two items with name and item');
    }
  }
  for (const meta of metas.filter(a => a.property === 'og:image')) {
    try {
      const image = new URL(meta.content);
      if (image.origin === origin && !fs.existsSync(path.join(dist, decodeURIComponent(image.pathname)))) fail('missing Open Graph image asset');
    } catch { fail('invalid Open Graph image URL'); }
  }
}
for (const [route, page] of routes) {
  const label = path.relative(dist, page.file);
  if (page.noindex && sitemapUrls.has(page.canonical)) errors.push(`${label}: noindex page included in sitemap`);
  if (!page.noindex && !sitemapUrls.has(page.canonical)) errors.push(`${label}: indexable page missing from sitemap`);
  for (const m of page.html.matchAll(/href="([^"]+)"/g)) {
    let url;
    try { url = new URL(decode(m[1]), new URL(route.endsWith('/') ? route : route + '/', origin)); } catch { continue; }
    if (url.origin !== origin || !url.hash) continue;
    const target = routes.get(url.pathname.replace(/\/$/, '') || '/');
    if (!target) continue; // File/route existence is checked by check-links.
    let id;
    try { id = decodeURIComponent(url.hash.slice(1)); } catch { errors.push(`${label}: malformed fragment ${m[1]}`); continue; }
    if (!id) continue;
    const ids = [...target.html.matchAll(/\bid="([^"]+)"/g)].map(match => decode(match[1]));
    if (!ids.includes(id)) { errors.push(`${label}: missing fragment target ${m[1]}`); continue; }
    // A fixed header hides targets that have no scroll margin. #main is the skip-link target.
    const tag = [...target.html.matchAll(/<\w+\b[^>]*>/g)].map(t => t[0]).find(t => attrs(t).id === id);
    if (id !== 'main' && !/\bscroll-mt-/.test(attrs(tag || '').class || '')) errors.push(`${label}: fragment target ${m[1]} needs a scroll-mt-* class`);
  }
}
for (const url of sitemapUrls) {
  const page = [...routes.values()].find(p => p.canonical === url);
  if (!page) errors.push(`sitemap: URL has no built page: ${url}`);
}
const robotsFile = path.join(dist, 'robots.txt');
if (!fs.existsSync(robotsFile)) errors.push('robots.txt is missing');
else {
  const robots = fs.readFileSync(robotsFile, 'utf8');
  if (/^\s*Disallow:\s*\/\s*$/im.test(robots)) errors.push('robots.txt blocks the whole site');
  const robotsSitemaps = [...robots.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map(m => m[1]);
  for (const url of robotsSitemaps) {
    let parsed;
    try { parsed = new URL(url); } catch { errors.push(`robots.txt: invalid Sitemap URL ${url}`); continue; }
    if (parsed.origin !== origin) errors.push(`robots.txt: Sitemap must use ${origin}: ${url}`);
    else if (!fs.existsSync(path.join(dist, decodeURIComponent(parsed.pathname)))) errors.push(`robots.txt: Sitemap file is missing from the build: ${url}`);
  }
}
for (const file of files(dist)) {
  if (!/(^|[\\/])sitemap-index\.xml$/.test(file)) continue;
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/<loc>(.*?)<\/loc>/g)) {
    const url = new URL(decode(m[1]));
    if (!fs.existsSync(path.join(dist, decodeURIComponent(url.pathname)))) errors.push(`sitemap-index: referenced file is missing: ${url.href}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`SEO checks passed: ${routes.size} HTML pages, ${sitemapUrls.size} sitemap URLs, metadata and fragment targets.`);
