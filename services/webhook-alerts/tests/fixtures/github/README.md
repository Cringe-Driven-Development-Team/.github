# Official GitHub webhook examples

Unmodified payload examples downloaded on 2026-10-24 from the official Octokit
webhooks repository (`payload-examples/api.github.com/`):

- `issues-opened.json`: https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/issues/opened.payload.json
- `pr-opened.json`: https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/pull_request/opened.payload.json
- `push.json`: https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/push/payload.json
- `comment-created.json`: https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/issue_comment/created.payload.json
- `review-submitted.json`: https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/pull_request_review/submitted.payload.json

Tests derive cases from these examples by overriding event-specific fields with
fictional names, IDs and times. No production payloads or secrets are included.

`backend-release-contract.json` — синтетические backend Deployment/previous success,
run/attempt и reusable job/steps по backend#42. Job `deploy / deploy` подтверждён
реальным CI run backend 42370270096, attempt 1; SHA/digest/IDs внутри fixture
вымышленные. Backend API tests читают этот JSON напрямую. Producer #42 должен
использовать ту же fixture; после его реализации сравнить файлы побайтно.
Rollback job `rollback / deploy` пока целевое имя, не свидетельство запуска.
