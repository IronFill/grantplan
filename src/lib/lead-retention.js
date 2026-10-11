// Netlify Blobs has no KV-style TTL. Scheduled cleanup uses original creation
// time, so retries do not extend personal-data retention indefinitely.
export async function pruneLeads(store, now = Date.now()) {
  let removed = 0;
  for await (const page of store.list({ paginate: true })) {
    for (const { key } of page.blobs) {
      if (!key.startsWith('lead:') && !key.startsWith('rate:')) continue;
      const record = await store.get(key, { type: 'json' });
      if (!record) continue;
      const expires = key.startsWith('rate:') ? record.until : Date.parse(record.createdAt) + 30 * 86400000;
      if (Number.isFinite(expires) && expires <= now) {
        await store.delete(key);
        removed++;
      }
    }
  }
  return removed;
}
