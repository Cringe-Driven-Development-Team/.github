# Apidog fixture status

`anonymized-live-structure.json` is anonymized-from-live-structure: its four top-level
string fields (`event`, `title`, multiline `content`, `appLink`) match a controller-verified
live endpoint create/update webhook. Values and identifiers are invented; no original
payload, credential or real project identifier is included. Observed event: `API_UPDATED`;
observed app host: `app.apidog.com`. No notification ID was present, so rolling raw-body
hash deduplication applies.

The controller verified `X-Apidog-Signature` as canonical base64 HMAC-SHA1 over exact raw
bytes. Tests exercise that header, both cryptographic encodings, malformed signatures,
and mismatched bodies/keys. `X-Synthetic-Signature` remains an arbitrary configured header.

`synthetic.json` is an older invented fixture used to exercise optional `notificationId`
deduplication and documented `sha1=<hex>` authentication; it is not a live payload claim.
Generic object IDs are deliberately ignored.

Live acceptance of the fix still awaits redeploy/retry and isolated Telegram verification;
see the [service runbook](../../../README.md). Sender remains disabled.
