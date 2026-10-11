// ���� ���?�� �਩��� ��� (functions/submit.js).
// �?��?��� Telegram API � KV - ��ॢ?��� ���?�� ��� ��०? � wrangler.
// �����: node scripts/test-submit.mjs

import { onRequestPost } from '../functions/submit.js';

function makeKV() {
  const data = new Map();
  return {
    _data: data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
}

function ctx(env, { body, ip = '1.1.1.1' } = {}) {
  const headers = new Headers();
  headers.set('CF-Connecting-IP', ip);
  return {
    request: new Request('https://x/submit', { method: 'POST', headers, body: JSON.stringify(body) }),
    env,
  };
}

const VALID = { name: '?��� ���७��', phone: '+380501234567', messenger: 'Telegram' };
const CONFIGURED = { TG_BOT_TOKEN: 'token', TG_CHAT_ID: '123' };

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ? ${label}`);
  } else {
    console.error(`  ? ${label}${detail ? ' - ' + detail : ''}`);
    failures++;
  }
}

// ���宯��� ��०�: ����� ��� �� ������� ॠ�쭮 ��㪠� � Telegram.
const realFetch = globalThis.fetch;
let sentMessages = [];
globalThis.fetch = async (url, init) => {
  sentMessages.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

console.log('�਩�� ���:');

// 1. �������� �?��: ���������⮢���� Telegram �?��� �� ���� ��?�
{
  sentMessages = [];
  const res = await onRequestPost(ctx({}, { body: VALID }));
  const data = await res.json();
  check('��� TG env ������� �������, � �� ok:true', res.status === 503 && data.ok === false, `status=${res.status} ok=${data.ok}`);
  check('��� TG env �?箣� �� ���ᨫ������', sentMessages.length === 0);
}

// 2. ��ଠ�쭨� ���
{
  sentMessages = [];
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  const data = await res.json();
  check('���?��� ��� �਩�������', res.status === 200 && data.ok === true, `status=${res.status}`);
  check('��� ��� � Telegram', sentMessages.length === 1 && sentMessages[0].url.includes('sendMessage'));
  check('���?�������� �?���� ?�\'� � ⥫�䮭',
    sentMessages[0]?.body.text.includes('?��� ���७��') && sentMessages[0]?.body.text.includes('+380501234567'));
}

// 3. ���?���?� ⥫�䮭�
{
  const bad = [
    ['��஦�� ?�\'�', { ...VALID, name: '' }],
    ['⥫�䮭 ��� +380', { ...VALID, phone: '0501234567' }],
    ['�����⪨� ⥫�䮭', { ...VALID, phone: '+38050123' }],
    ['⥫�䮭 � �?�ࠬ�', { ...VALID, phone: '+380abcdefghi' }],
  ];
  for (const [label, body] of bad) {
    const res = await onRequestPost(ctx(CONFIGURED, { body }));
    check(`�?�娫��: ${label}`, res.status === 422, `status=${res.status}`);
  }
}

// 4. Honeypot
{
  sentMessages = [];
  const res = await onRequestPost(ctx(CONFIGURED, { body: { ...VALID, hp_gp_2026: 'bot' } }));
  check('Honeypot ������� 200 (��� �� ����� �?����?)', res.status === 200);
  check('Honeypot �?箣� �� ���ᨫ��', sentMessages.length === 0);
}

// 5. Rate limiting
{
  const kv = makeKV();
  const env = { ...CONFIGURED, COMMENTS_KV: kv };
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const res = await onRequestPost(ctx(env, { body: VALID, ip: '9.9.9.9' }));
    statuses.push(res.status);
  }
  check('�?�?� ���쮢�� �?�� 5 ��� � ���?�� IP', statuses.slice(5).every((s) => s === 429), `�����: ${statuses.join(',')}`);

  const other = await onRequestPost(ctx(env, { body: VALID, ip: '8.8.8.8' }));
  check('?�� IP �� �����������', other.status === 200, `status=${other.status}`);
}

// 6. ��� KV �?�?� �� ����� ���
{
  sentMessages = [];
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  check('��� �ਢ\'易���� KV �ଠ ����� ���?', res.status === 200, `status=${res.status}`);
}

// 7. ������� Telegram �� ��������� �� ��?�
{
  globalThis.fetch = async () => new Response('Bad Request', { status: 400 });
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  const data = await res.json();
  check('��?� Telegram ������� �������', res.status === 502 && data.ok === false, `status=${res.status}`);
}

// HTTP success alone is insufficient: the delivery service must acknowledge it.
for (const body of ['{"ok":false}', '{}', 'not JSON']) {
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const res = await onRequestPost(ctx(CONFIGURED, { body: VALID }));
  check('Reject unconfirmed delivery: ' + body, res.status === 502 && (await res.json()).ok === false);
}

globalThis.fetch = realFetch;

console.log(failures ? `\n? �஢����� ��ॢ?ப: ${failures}` : '\n? ��? ��ॢ?ન �ன����');
process.exit(failures ? 1 : 0);
