// Prove that the publication guard rejects regressions, using temporary HTML only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-seo.mjs', import.meta.url));
const tempRoot = path.dirname(checker);
const dir = fs.mkdtempSync(path.join(tempRoot, '.grantplan-seo-'));
const valid = '<html lang="uk"><head><title>Example</title><meta name="description" content="A real description that is long enough for search results"><meta property="og:title" content="Example"><meta property="og:description" content="A real description"><meta property="og:image" content="https://example.com/image.png"><link rel="canonical" href="https://grantplan.com.ua/"><script type="application/ld+json">{"name":"Example"}</script></head><body><h1>Example</h1><a href="#lead">Audit</a><section id="lead" class="scroll-mt-24"></section></body></html>';
const robots = 'User-agent: *\nAllow: /\nSitemap: https://grantplan.com.ua/sitemap-0.xml\n';
const sitemap = '<urlset><url><loc>https://grantplan.com.ua/</loc></url></urlset>';
function run(html, xml = sitemap, robotsText = robots) {
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'sitemap-0.xml'), xml);
  if (robotsText === null) fs.rmSync(path.join(dir, 'robots.txt'), { force: true });
  else fs.writeFileSync(path.join(dir, 'robots.txt'), robotsText);
  const result = spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
try {
  assert.equal(run(valid).status, 0, 'valid page must pass');
  const cases = [
    ['UTF-8 damage', valid.replace('<h1>Example', '<h1>\uFFFD'), /damaged UTF-8/],
    ['incorrect canonical', valid.replace('href="https://grantplan.com.ua/"', 'href="https://grantplan.com.ua/wrong/"'), /canonical must be/],
    ['hidden page in sitemap', valid.replace('</head>', '<meta name="robots" content="noindex"></head>'), /noindex page included/],
    ['broken anchor', valid.replace('id="lead"', 'id="other"'), /missing fragment target/],
    ['missing description', valid.replace('content="A real description that is long enough for search results"', 'content=""'), /non-empty description/],
    ['invalid structured data', valid.replace('{"name":"Example"}', '{invalid}'), /invalid JSON-LD/],
    ['missing Open Graph image', valid.replace(/<meta property="og:image"[^>]*>/, ''), /missing og:image/],
    ['missing Open Graph title', valid.replace(/<meta property="og:title"[^>]*>/, ''), /missing og:title/],
    ['too short description', valid.replace('A real description that is long enough for search results', 'abc'), /description is 3 characters/],
    ['too long title', valid.replace('<title>Example</title>', `<title>${'x'.repeat(130)}</title>`), /title is 130 characters/],
    ['anchor without scroll margin', valid.replace(' class="scroll-mt-24"', ''), /needs a scroll-mt/],
    ['empty breadcrumb list', valid.replace('{"name":"Example"}', '{"@type":"BreadcrumbList","itemListElement":[]}'), /BreadcrumbList needs/],
  ];
  for (const [name, html, message] of cases) {
    const result = run(html);
    assert.equal(result.status, 1, `${name} must fail`);
    assert.match(result.stderr, message, name);
  }
  assert.equal(run(valid, '<urlset></urlset>').status, 1, 'omitted public page must fail');
  const blocked = run(valid, sitemap, 'User-agent: *\nDisallow: /\nSitemap: https://grantplan.com.ua/sitemap-0.xml\n');
  assert.equal(blocked.status, 1, 'robots.txt blocking the site must fail');
  assert.match(blocked.stderr, /blocks the whole site/);
  assert.equal(run(valid, sitemap, 'User-agent: *\nAllow: /\n').status, 0, 'a direct sitemap submitted elsewhere is allowed');
  assert.equal(run(valid, sitemap, null).status, 1, 'missing robots.txt must fail');
  const wrongHost = run(valid, sitemap, 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap-0.xml\n');
  assert.equal(wrongHost.status, 1, 'Sitemap on another origin must fail');
  fs.writeFileSync(path.join(dir, 'sitemap-index.xml'), '<sitemapindex><sitemap><loc>https://grantplan.com.ua/sitemap-9.xml</loc></sitemap></sitemapindex>');
  assert.equal(run(valid).status, 1, 'sitemap index pointing to a missing file must fail');
  assert.match(run(valid).stderr, /referenced file is missing/);
  fs.rmSync(path.join(dir, 'sitemap-index.xml'));
  console.log('SEO guard: valid fixture, twelve page regressions and robots/sitemap regressions passed.');
} finally {
  // Remove only the exact directory created by mkdtemp above.
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(tempRoot));
  assert.ok(path.basename(dir).startsWith('.grantplan-seo-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
