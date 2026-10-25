# Telegram-only HTTP proxy for webhook-alerts

Part of [the webhook-alerts design](../specs/2026-10-24-webhook-alerts-design.md) and [implementation plan](2026-10-24-webhook-alerts.md).

## Context and decision

On the auxiliary VPS, direct Bot API calls time out. `vk-monitoring` uses an existing VLESS exit through a local SOCKS proxy. Bun `fetch` supports an HTTP/HTTPS proxy per request, so this service will accept an optional `TELEGRAM_PROXY_URL` for Telegram sends only. GitHub enrichment and other outbound requests remain direct. A local proxy still needs a remote exit; provisioning that exit is a separate infrastructure task once its configuration is available. Do not enable the worker before the proxy and queue cutover are verified.

## Files

- `services/webhook-alerts/src/config.ts`: parse and validate the optional proxy URL without including its value in errors.
- `services/webhook-alerts/src/telegram.ts`: pass that proxy to Bun `fetch` for `sendMessage` only; keep the existing direct behavior when unset.
- `services/webhook-alerts/tests/main.test.ts` and the existing Telegram sender tests: prove acceptance/rejection and request scoping.
- `services/webhook-alerts/README.md`: document the option and the need for a remote exit.

## Task 1: proxy option and sender test

1. Add a failing config test: an `http://proxy.internal:2080` value is retained in `config.telegram.proxyUrl` when sending is enabled; `socks5h://proxy.internal:2080` and malformed values fail with `TELEGRAM_PROXY_URL` in the error and without the supplied URL.
2. Add a failing sender test: with the proxy configured, the injected `fetcher` sees `proxy: { url: 'http://proxy.internal:2080', respectNoProxy: false }` on the Telegram request; without it the request options have no `proxy` property. The test must exercise the worker path, not only a formatter.
3. Implement `proxyUrl?: string` in `TelegramConfig`, validate only `http:` or `https:` with a non-empty hostname in `loadConfig`, and pass it to the Telegram `fetch` call with `respectNoProxy: false`. Do not use process-wide proxy environment variables.
4. Update the README with `TELEGRAM_PROXY_URL`, remote-exit requirement, and the fact that only Telegram delivery uses it.
5. Run `cd services/webhook-alerts && bun test && bun run typecheck`, then `git diff --check`. Existing queue, dedupe and retry behavior must remain unchanged.

## Review focus

- No proxy credentials or token-bearing request URL in validation or network-error logs.
- The sender uses an explicit proxy only for Telegram, while GitHub API calls stay direct.
- Empty or unsupported proxy schemes cannot silently fall back to direct Telegram access.
- With the option absent, existing tests and direct behavior remain valid.
