// Prove that the publication guard rejects regressions, using temporary HTML only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grantplan-seo-'));
const checker = fileURLToPath(new URL('./check-seo.mjs', import.meta.url));
const valid = '<html lang="uk"><head><title>Example</title><meta name="description" content="A real description"><link rel="canonical" href="https://grantplan.com.ua/"><script type="application/ld+json">{"name":"Example"}</script></head><body><h1>Example</h1><a href="#lead">Audit</a><section id="lead"></section></body></html>';
const sitemap = '<urlset><url><loc>https://grantplan.com.ua/</loc></url></urlset>';
function run(html, xml = sitemap) {
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'sitemap-0.xml'), xml);
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
    ['missing description', valid.replace('content="A real description"', 'content=""'), /non-empty description/],
    ['invalid structured data', valid.replace('{"name":"Example"}', '{invalid}'), /invalid JSON-LD/],
  ];
  for (const [name, html, message] of cases) {
    const result = run(html);
    assert.equal(result.status, 1, `${name} must fail`);
    assert.match(result.stderr, message, name);
  }
  assert.equal(run(valid, '<urlset></urlset>').status, 1, 'omitted public page must fail');
  console.log('SEO guard: valid fixture and seven regression cases passed.');
} finally {
  // Remove only the exact directory created by mkdtemp above.
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('grantplan-seo-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
