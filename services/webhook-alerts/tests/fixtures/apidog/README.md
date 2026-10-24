# Apidog fixture status

`synthetic.json` is an invented, anonymized test fixture, **not an observed Apidog delivery**.
No credential or real project identifier is included. `X-Synthetic-Signature` in tests
is an arbitrary configured header, not a claim about Apidog's actual header.

The provisional projection reads `event`, `object.name`, `object.url`, and a string
`notificationId` as a delivery ID. Generic `id` is deliberately ignored because it
could identify an endpoint or document rather than a notification. No actor, test
result, object URL, or API path is inferred. Unknown/missing fields produce a short
source/event card. Actual project fields must be verified before production use.

[Official notification documentation](https://share.apidog.com/apidoc/docs-site/544525/notification-settings-616240m0)
describes HMAC SHA-1 with `sha1=` and supported trigger categories, but does not
specify the signature header or a JSON payload schema. An available project OpenAPI
export describes API resources and does not establish notification settings/payloads.

Live fixture capture, header verification and Telegram acceptance remain pending;
see the [service runbook](../../../README.md).
