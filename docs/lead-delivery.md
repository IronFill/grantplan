# Lead delivery and recovery

The form requests a preferred time in Europe/Kyiv. It does not reserve an
appointment: the owner confirms availability with the visitor.

Success requires HTTP success and `ok:true` from Telegram. A timeout is an
unknown result, not proof that Telegram rejected the message.

## Private outbox

Cloudflare uses LEADS_KV, falling back to the existing COMMENTS_KV binding.
No new paid service is required. When no binding exists, direct delivery still
works, but there is no durable backup. Verify the production binding before
claiming loss protection. Never expose this namespace through a public API.

Netlify uses the private `grantplan-leads` Blobs store. Legacy functions call
connectLambda when the invocation supplies a Blobs context. A missing storage
context fails closed. Local unit tests use no production credentials.

Records contain the contact, message, request ID, timestamps and delivery state.
Cloudflare expires records after 30 days from the latest write. Netlify's daily
cleanup removes records 30 days after creation (up to one day scheduling delay).
The Telegram copy remains in the owner's chat and is managed separately.

## Recovery

In the hosting dashboard, inspect private `lead:` records in state `failed`,
`uncertain` or `sending`. Compare the contact/message with the Telegram inbox.
If the message arrived, mark the record `sent`. If it did not arrive, contact
the customer manually or, after reconciling the inbox, mark it `failed` so the
same request can safely be retried. Do not blindly resend uncertain records.
No public recovery endpoint or automatic retry loop is installed.

A saved-but-unconfirmed submission displays an explicit message and keeps the
visitor's input. It does not show success or emit the conversion event.
Known Telegram rejection permits retry; an unknown delivery blocks repeat of
the same request. Edited input creates a new request ID.

Request IDs provide best-effort deduplication. Cloudflare KV and the Netlify
read/write sequence are not transactions: simultaneous requests can race.
Rate limits are also best effort. Do not claim exactly-once delivery.

## Deployment checks

Known public placement codes are resolved from an exact UTM tuple at submission
time (see `src/lib/campaigns.js`). Both form types send only the registry ID;
the server independently resolves it. Unknown IDs and arbitrary extra fields
are discarded. No full URL, free-text UTM, referrer or advertising click ID is
stored by this feature. It uses no browser persistence and does not carry a
campaign across an untagged navigation. A code is untrusted attribution, not
proof of a real customer or the first touch. A missing code means unknown.

The existing success/uncertain rules still apply. Unit tests mock all Telegram
calls, including the new campaign tests; they cannot confirm production inbox
receipt or outbox bindings.

- Confirm the existing Telegram secrets without printing their values.
- Confirm the private KV binding on Cloudflare, or Blobs access on Netlify.
- On Netlify, verify that lead-cleanup appears as Scheduled and run it once
  from the dashboard. Monitor failures of the daily cleanup.
- Send a clearly labelled owner test only when requested; verify receipt.
- Inspect contact data only in the private dashboard, never in build logs.

References: https://docs.netlify.com/build/data-and-storage/netlify-blobs/
and https://docs.netlify.com/build/functions/scheduled-functions/.
