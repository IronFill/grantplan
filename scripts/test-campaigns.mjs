import assert from 'node:assert/strict';
import { CAMPAIGNS, campaignFromUrl, campaignUrl, getCampaign } from '../src/lib/campaigns.js';
import { validateLead, validateTelegramText } from '../src/lib/lead-validation.js';
import { leadMessage } from '../src/lib/lead-delivery.js';
import { onRequestPost } from '../functions/submit.js';
import { handler } from '../netlify/functions/submit.mjs';
import { readFileSync } from 'node:fs';

const valid = { requestId: '12345678-1234-4123-8123-123456789abc', consent: true, name: 'TEST', phone: '+380501234567' };
assert.equal(new Set(CAMPAIGNS.map(c => c.id)).size, CAMPAIGNS.length, 'Placement IDs must be unique');
assert.equal(new Set(CAMPAIGNS.map(c => [c.source, c.medium, c.campaign, c.content].join('|'))).size, CAMPAIGNS.length, 'A UTM combination must identify only one placement');
const pilot = JSON.parse(readFileSync(new URL('../docs/marketing-playbook/search-pilot-2026-10-17.json', import.meta.url), 'utf8'));
for (const group of pilot.ad_groups) {
  const expected = group.attribution;
  const registered = getCampaign(expected.proposed_campaign_id);
  assert.ok(registered, `Search group ${group.key} must be registered before using its URL`);
  assert.equal(campaignFromUrl(expected.proposed_final_url), registered.id);
  for (const key of ['source', 'medium', 'campaign', 'content']) assert.equal(registered[key], expected[`utm_${key}`]);
  assert.equal(new URL(expected.proposed_final_url).pathname, '/poslugy/');
}
for (const campaign of CAMPAIGNS) {
  const url = campaignUrl(campaign.id, '/#lead');
  assert.equal(campaignFromUrl(url), campaign.id);
  const extra = new URL(url); extra.searchParams.set('unused', 'private@example.com');
  assert.equal(campaignFromUrl(extra.href), campaign.id);
  const checked = validateLead({ ...valid, campaignId: campaign.id });
  assert.equal(checked.values.campaignId, campaign.id);
  assert.ok(leadMessage(checked.values).includes(campaign.id));
  assert.ok(validateTelegramText(leadMessage(checked.values)).ok);
}
const known = campaignUrl('youtube-budget-guide');
const scheduledPosts = [
  ['facebook-budget-cards-oct18', '/blog/yak-pereviryty-koshtorys/#lead'],
  ['facebook-plan-scope-oct20', '/poslugy/#lead'],
  ['facebook-audit-prep-oct22', '/#lead'],
];
assert.equal(new Set(scheduledPosts.map(([id, path]) => campaignUrl(id, path))).size, 3);
for (const [id, path] of scheduledPosts) {
  const link = campaignUrl(id, path);
  assert.equal(campaignFromUrl(link), id);
  assert.equal(new URL(link).pathname, path.split('#')[0]);
  assert.equal(new URL(link).hash, '#lead');
  const checked = validateLead({ ...valid, campaignId: campaignFromUrl(link) });
  assert.ok(checked.ok);
  assert.ok(leadMessage(checked.values).includes(id));
}
assert.equal(campaignFromUrl(known + '&utm_content=other'), '', 'Ambiguous duplicate parameters are not attributed');
assert.equal(campaignFromUrl('https://grantplan.com.ua/?utm_source=private@example.com'), '');
assert.equal(campaignFromUrl('not a URL'), '');
assert.equal(getCampaign('__proto__'), undefined);
assert.throws(() => campaignUrl('youtube-budget-guide', 'https://example.com/'));
for (const campaignId of ['unknown', '<script>secret</script>', 'x'.repeat(10000), {}, null]) {
  const checked = validateLead({ ...valid, campaignId });
  assert.equal(checked.ok, true, 'Unrecognised attribution must not block a real lead');
  assert.equal(checked.values.campaignId, undefined);
}

const originalFetch = globalThis.fetch;
const oldToken = process.env.TG_BOT_TOKEN, oldChat = process.env.TG_CHAT_ID;
let messages = [];
try {
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/botTEST/'));
    messages.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  };
  process.env.TG_BOT_TOKEN = 'TEST'; process.env.TG_CHAT_ID = 'TEST';
  for (const campaign of CAMPAIGNS) {
    const payload = { ...valid, campaignId: campaign.id, utm_source: 'private@example.com', gclid: 'PRIVATE_CLICK_ID', referrer: 'https://private.example/path' };
    const records = new Map();
    const res = await onRequestPost({ request: new Request('https://test/submit', { method: 'POST', body: JSON.stringify(payload) }), env: {
      TG_BOT_TOKEN: 'TEST', TG_CHAT_ID: 'TEST', LEADS_KV: { get: async k => records.get(k), put: async (k,v) => records.set(k,v) },
    } });
    assert.equal(res.status, 200);
    const stored = records.get('lead:' + valid.requestId);
    assert.ok(stored.includes(campaign.id));
    assert.ok(!stored.includes('private@example.com') && !stored.includes('PRIVATE_CLICK_ID') && !stored.includes('private.example'));
    const other = await handler({ httpMethod: 'POST', body: JSON.stringify(payload) });
    assert.equal(other.statusCode, 200);
    assert.equal(messages.length, 2);
    for (const message of messages) {
      assert.ok(message.text.includes(campaign.id));
      assert.ok(!message.text.includes('private@example.com') && !message.text.includes('PRIVATE_CLICK_ID') && !message.text.includes('private.example'));
    }
    messages = [];
  }
} finally {
  globalThis.fetch = originalFetch;
  if (oldToken === undefined) delete process.env.TG_BOT_TOKEN; else process.env.TG_BOT_TOKEN = oldToken;
  if (oldChat === undefined) delete process.env.TG_CHAT_ID; else process.env.TG_CHAT_ID = oldChat;
}
console.log('Campaign attribution: known links, ambiguous input, privacy filtering, both handlers and outbox passed; no network calls.');
