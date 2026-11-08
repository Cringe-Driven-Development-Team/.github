# Независимый CI/CD VPS3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHubBot и webhook-alerts независимо проходят CI, публикуются и автоматически выкатываются на VPS3 без коммитов digest в infra.

**Architecture:** Publisher каждого сервиса публикует неизменяемый SHA tag и release artifact. Отдельный workflow_run в `.github` запускает центральный workflow в infra и ждёт его результата. Исполнитель под общей очередью читает сохранённые desired/confirmed версии, обновляет один Compose-сервис и подтверждает health; обычный infra apply сохраняет выбранные версии.

**Tech Stack:** существующие GitHub Actions, Bun 1.4.4/TypeScript, Python stdlib, Ansible, Docker Compose, GHCR. Новых runtime-зависимостей нет.

**Spec:** [2026-11-08-vps3-cd-design.md](../specs/2026-11-08-vps3-cd-design.md), подтверждена владельцем 2026-11-08.

## Global Constraints

- GitHubBot и webhook-alerts автоматически выкатываются после успешного CI и публикации своего образа из main репозитория `.github`.
- Обновление одного сервиса не требует выпуска или перезапуска другого.
- Коммит digest в infra для каждого выпуска больше не нужен.
- Обычные изменения инфраструктуры сохраняют выбранные версии приложений.
- CD проверяет VPS3 самостоятельно и не зависит от внешней проверки BFF/Go. Общие проверки infra сохраняются.
- Никакого latest и автоматического возврата к закреплённому inventory digest.
- Существующие SQLite/WAL, shared Compose networks, runtime-токены и один polling-процесс GitHubBot сохраняются.
- Runtime GitHubBot PAT для Issues/Projects не используется для dispatch. Секреты не попадают в код, чат или логи.
- Автоматический откат, Telegram-уведомления, ремонт backend и требования безостановочной работы не входят в задачу.
- Обязательные проверки GitHubBot остаются обязательными; no_log и preview без изменений VPS сохраняются.

## Review Focus

1. Повтор publisher с тем же SHA и иным локальным результатом сборки сохраняет первоначальный registry digest (Task 1).
2. Ошибка после записи desired, но до health не возвращает старый image при следующем общем apply (Tasks 2–3).
3. Два CD и общий apply одновременно не отменяют pending друг друга; поздний старый source не откатывает новый (Tasks 2, 4–5).
4. Успешный чужой/PR publisher, повреждённый artifact или перепутанный service/digest не достигает production-команд (Tasks 4–5).
5. Общий `services/webhook-alerts/src/format.ts` выпускает оба сервиса, README только документирует и не выпускает ни один (Task 1).

## Контекст и границы

Это один связанный контракт между двумя репозиториями, поэтому один план; отдельно выпускаемые части — infra executor и source publishers/caller — получают свои PR. Подготовить isolated worktrees от актуального main обоих репозиториев, сохранить изменения соседних сессий. Не использовать ветку PR116. PR120 — отдельная текущая выкладка, её новый preview regression не потерять.

План находится в `.github`; префиксы `.github/` и `infra/` ниже обозначают корни репозиториев, а `.github/.github/workflows/` — workflow-каталог репозитория `.github`. Перед реализацией требуется выбор владельцем способа выполнения именно этого плана.

## Общие интерфейсы

- `Service = "githubbot" | "webhook-alerts"`; Compose service: `githubbot` либо `hooks` соответственно. Registry repository строго `ghcr.io/cringe-driven-development-team/<Service>`.
- `Release = {service, image_ref, source_sha, publisher_run_id, publisher_run_attempt}`; SHA — 40 lowercase hex, digest — `sha256:` + 64 lowercase hex, IDs — положительные целые. `image_ref` включает registry repository и `@digest`.
- Publisher artifact `release-<service>-<run_attempt>` содержит ровно `release.json` (UTF-8 JSON, максимум 16 KiB). Job output `image_ref` дополнительно доступен через GITHUB_OUTPUT; logs не являются интерфейсом.
- Publisher workflow filenames/names сохраняются: `githubbot-image.yml` / `GitHubBot image`, `webhook-alerts-image.yml` / `Webhook alerts image`.
- Dispatch: `auxiliary-deploy.yml`, ref `main`, inputs `operation=deploy`, `service`, `image_ref`, `source_sha`, `request_id`. `request_id = <service>:<publisher_run_id>:<publisher_run_attempt>:<caller_run_id>:<caller_run_attempt>`; компоненты позволяют проверить publisher и различить повторы caller.
- Инициализация: тот же executor, `operation=initialize`, `initial_releases_json` — ровно два Release. Deploy-поля при initialize пусты; bootstrap-поле при deploy пусто. Отклонять смешанный ввод.
- `/opt/hooks/releases.json`, root:root 0600, атомарная запись через Ansible copy: `{ "version": 1, "services": { "githubbot": {"desired": Release, "confirmed": Release|null}, "webhook-alerts": {"desired": Release, "confirmed": Release|null} } }`. Поля не содержат секретов. Ошибка schema/отсутствие состояния останавливают обычный apply, не включают fallback.
- Desired записывается после проверок image/config и до изменения постоянного Compose. Confirmed обновляется только после проверки фактического контейнера. На сбое desired остаётся выбранной версией, confirmed — последней проверенной; автоматического rollback нет.
- Все writers через infra используют job concurrency `{group: infra-production, cancel-in-progress: false, queue: max}`. Ручные операции runbook также выполняются через executor; локальный concurrent Ansible вне очереди не поддерживается.

## Файлы и ответственность

| Repo / файлы | Назначение |
| --- | --- |
| `.github/scripts/auxiliary-publish.sh`; `tests/auxiliary-publish.test.ts` | Идемпотентная публикация и структурированный release artifact; shell проверяется из Bun через fake registry/docker |
| `.github/.github/workflows/{githubbot-image,webhook-alerts-image,checks}.yml`; существующие workflow tests | Собственные CI gates, path filters, image smoke |
| `infra/ansible/filter_plugins/hooks_release.py`; `tests/test_hooks_release.py` | Чистые schema/state переходы; Ansible управляет чтением и атомарной записью |
| `infra/ansible/roles/hooks/tasks/{release-state,deploy,verify-release}.yml` | Загрузка версий, точечный deploy, фактическая проверка |
| `infra/ansible/{deploy-auxiliary,initialize-auxiliary-releases}.yml` | Узкие entrypoints без bootstrap/firewall/backend |
| `infra/ansible/roles/hooks/tasks/{main,validate,prepare-githubbot}.yml`, defaults, auxiliary.yml, verify.yml, inventory auxiliary vars | Использование persisted versions, переиспользование gates и удаление application pins |
| `infra/scripts/auxiliary_release.py`; `ansible/tests/test_auxiliary_release.py` | Валидация доверенной публикации/GHCR и source ancestry через stdlib + subprocess argv |
| `infra/.github/workflows/{auxiliary-deploy,infra,actionlint}.yml`; `ansible/tests/test_auxiliary_workflow.py` | Исполнитель с существующими production credentials и общая очередь |
| `.github/scripts/auxiliary-cd.ts`; `tests/auxiliary-cd.test.ts`; `.github/workflows/auxiliary-cd.yml` | workflow_run: artifact, dispatch, ожидание точного run |
| README/RUNBOOK обоих репозиториев | Новый выпуск, первый запуск, recovery и credentials |

### Task 1: Собственные CI gates и неизменяемые публикации

**Files:** source publisher workflows, `checks.yml`, новый `scripts/auxiliary-publish.sh`, `tests/auxiliary-publish.test.ts`, существующие `tests/{githubbot,webhook}-workflows.test.ts`, `tests/lint.sh` только для подключения нового скрипта.
**Interfaces:** производит Release/artifact/output из раздела «Общие интерфейсы»; `auxiliary-publish.sh SERVICE LOCAL_IMAGE` получает IMAGE_SHA/GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT и registry credentials через env.

- [ ] **Написать RED:** stub registry/docker проверяет следующие наблюдения, а не наличие строк:
  ```ts
  expect(existingTag.publishCalls).toBe(0);
  expect(existingTag.release.image_ref).toBe(originalDigest);
  expect(registry500.exitCode).not.toBe(0);
  expect(registry404Missing.publishCalls).toBe(1);
  expect(tagAndDigestMismatch.exitCode).not.toBe(0);
  ```
  Path cases: githubbot/src → bot; webhook-alerts/src/worker.ts → alerts; webhook-alerts/src/format.ts → оба; services/*/README.md → ни один; собственный publisher/smoke/workflow tests → соответствующий сервис; общий publish helper → оба.
- [ ] **Запустить RED:** `bun test tests/auxiliary-publish.test.ts tests/githubbot-workflows.test.ts tests/webhook-workflows.test.ts`; ожидается отсутствие helper/нового контракта.
- [ ] **Реализовать:** общий небольшой shell helper на базе существующей alerts registry-probe логики. Только подтверждённый MANIFEST_UNKNOWN/NAME_UNKNOWN разрешает push. При существующем SHA tag вернуть его проверенный digest; при 401/403/429/5xx остановиться. Проверить digest ответа/body и соответствие digest endpoint, анонимную доступность и OCI source. Сериализовать release.json через jq, не интерполяцию JSON в shell. Upload artifact после всех gates; output не зависит от человеческих логов.
- [ ] **Обновить publishers:** alerts получает существующие install/test/typecheck/build/smoke команды из checks; GitHubBot сохраняет их. Собрать до login/push. Push/main path filters только runtime/build/test/helper файлы; точный shared format.ts включён в оба. Сохранить PR checks без production credentials и их имена; не делать required checks pending из-за whole-workflow path filter. SHA-tag lock остаётся per service/SHA, без отмены публикации. Новые workflow-version зависимости не обновлять без нужды.
- [ ] **GREEN:** указанные Bun tests, typecheck обоих services, оба существующих docker smoke, `bash tests/lint.sh`. Для tests не обращаться к live registry. Commit с publishers/tests как единым проверяемым изменением.

### Task 2: Состояние релизов и обычный infra apply

**Files:** `infra/ansible/filter_plugins/hooks_release.py`, `tests/test_hooks_release.py`, `roles/hooks/tasks/release-state.yml`, main/validate/defaults, auxiliary.yml, inventory auxiliary vars; существующие hooks/githubbot tests и README/RUNBOOK.
**Interfaces:** filters `hooks_release_validate(state: dict) -> dict`, `hooks_release_select(state: dict, release: dict) -> dict`, `hooks_release_confirm(state: dict, service: str) -> dict`; selector сохраняет соседний service и confirmed. Source-order проверяется Task 4 до select. `release-state.yml` выдаёт `hooks_release_state`, `hooks_image`, `hooks_image_source_tag`, `hooks_githubbot_image`, `hooks_githubbot_image_source_tag` из desired. Read/write выполняет Ansible, filters не имеют IO.

- [ ] **RED:** unittest fixtures без секретов:
  ```python
  self.assertEqual(select(state, bot2)['services']['webhook-alerts'], state['services']['webhook-alerts'])
  self.assertEqual(select(state, bot2)['services']['githubbot']['confirmed'], bot1)
  self.assertEqual(confirm(selected, 'githubbot')['services']['githubbot']['confirmed'], bot2)
  with self.assertRaises(ValueError): validate(state_with_wrong_repository)
  ```
  Также missing service, unknown schema, malformed SHA/digest, same SHA/different digest отклоняются. Check-mode читает state и планирует без записи. Повторный общий apply выбирает desired нового образа даже при старом confirmed.
- [ ] **Запустить:** `python -m unittest discover -s ansible/tests -p test_hooks_release.py -v`, получить ожидаемый RED.
- [ ] **Реализовать:** загрузить state до текущего validate в auxiliary.yml и hooks main; не потерять defaults role при pre_tasks. Удалить статические application image/source pins из defaults/inventory, сохранив proxy/Caddy pins. State не должен переопределяться остаточными inventory vars; helper в одном месте преобразует desired в существующие переменные шаблона. При пустом VPS auxiliary принимает явно переданный `hooks_initial_releases` (два валидированных Release), готовит desired с confirmed=null; при существующем Compose отсутствие state требует отдельной initialize-операции Task 4. Без неявного импорта/старых fallback. Fixtures тестов задают explicit state, не выключают GitHubBot.
- [ ] **GREEN:** новая suite + `test_hooks.py`/`test_githubbot.py`; syntax auxiliary; regression общего apply с сохранением обеих desired. Описание initial install и recovery в RUNBOOK, commit.

### Task 3: Точечная выкладка и подтверждение результата

**Files:** `infra/ansible/deploy-auxiliary.yml`, hooks tasks deploy/verify-release, prepare-githubbot/main, verify.yml, `tests/test_auxiliary_deploy.py` (новый), связанные tests/defaults только для переиспользования.
**Interfaces:** playbook принимает `auxiliary_release: Release`, предварительно проверенный executor; перечитывает state внутри очереди. `verify-release.yml` принимает `hooks_verify_services: [Service]`; проверяет desired и подтверждает только эти services.

- [ ] **RED:** существующий Docker/Ansible test harness моделирует candidate и state. Утверждения: bot deploy вызывает `up --no-deps ... githubbot`, alerts — `... hooks`; соседние ID/image/volumes не меняются; invalid config не меняет desired/Compose; health failure оставляет новый desired и старый confirmed; повтор того же release доводит confirmed; отсутствующая зависимость даёт ошибку до мутации. Отдельный тест full apply подтверждает оба после проверок, не ждёт BFF.
- [ ] **Запустить:** `python -m unittest discover -s ansible/tests -p test_auxiliary_deploy.py -v`, получить RED.
- [ ] **Реализовать:** hosts auxiliary/become, без roles users/common/docker/firewall/restic и без handler restart соседей. Проверить существующие Compose/env/proxy/network; анонимно pull только target. Подготовить временный candidate Compose из общего шаблона с сохранённым соседом, правильным project-directory и абсолютными env paths. GitHubBot config checker с `--no-deps`, без polling; переиспользовать подготовку owner SQLite без смены volume/path. Разделить существующий prepare-githubbot на нужные import_tasks только если это необходимо для вызова checker на candidate. Затем атомарно записать desired → постоянный Compose → `up --detach --no-deps --pull never --wait --wait-timeout 180 <target>`. Всегда убрать временные secret-файлы; no_log сохраняется.
- [ ] **Проверить результат:** ровно один контейнер target включая stopped, Running=true, Health.Status=healthy, Config.Image=desired.image_ref и Image ID соответствует локально инспектированному digest. Для alerts дополнительно существующий HTTPS /health; для bot никаких getUpdates. После успешной проверки атомарно confirm только target. Common auxiliary apply переиспользует verify-release для обоих, обычный verify.yml также переиспользует проверки без ослабления остальных.
- [ ] **GREEN:** focused suite, существующие hooks/githubbot suites, syntax deploy/auxiliary/verify. Native isolated fixture проверяет два сервиса, неизменный сосед/SQLite markers и failure recovery; тестовые контейнеры без Telegram/GitHub credentials. Commit.

### Task 4: Доверенный executor и начальное состояние

**Files:** `infra/scripts/auxiliary_release.py`, tests auxiliary_release/auxiliary_workflow, `ansible/initialize-auxiliary-releases.yml`, `.github/workflows/auxiliary-deploy.yml`, concurrency infra.yml, actionlint.yml, README/RUNBOOK.
**Interfaces:** CLI `python scripts/auxiliary_release.py validate --request <json-file> --output <validated-json-file>`; `check-order --state <json-file> --release <json-file>`; JSON files никогда не shell source. Functions `validate_request(request: dict, api) -> dict`, `validate_publication(release: dict, api, registry) -> None`, `check_order(current: dict, candidate: dict, api) -> None` с тестовыми fake adapters. GitHub API текущая версия `2026-03-10`.

- [ ] **RED:** fixtures successful trusted main push/attempt, fork, PR, failed/cancelled publisher, другой workflow filename, другая SHA/run attempt, чужой image, wrong OCI source, digest/tag mismatch, unavailable registry. Старый ancestor после нового — отказ; same SHA/same digest — разрешён; same SHA/other digest и divergent history — отказ. Пагинация успешных старых publisher runs для initialize не обрезается первой страницей. Все отказы до SSH/production secrets.
- [ ] **Запустить:** `python -m unittest discover -s ansible/tests -p 'test_auxiliary_*.py' -v`, получить RED для новых контрактов.
- [ ] **Реализовать validation:** allowlist и полные форматы; по run ID/attempt получить фактический completed/success push main run нужного workflow в `.github`, source_sha должен совпадать и быть reachable из текущего main. Проверить анонимный GHCR tag `sha-<source_sha>` и digest/OCI source; не запускать код или container из inputs. После загрузки saved state сравнить commits через GitHub compare; принимать только identical digest либо descendant. Если API недоступен — отказ, не guess.
- [ ] **Реализовать workflow:** только workflow_dispatch на main с operation из общего интерфейса. Безопасная проверка metadata до выдачи SSH; production job заново проверяет refs/order внутри очереди. Переиспользовать существующий secrets setup/cleanup, inventory/SSH env из infra.yml без расшифровки в лог. Job concurrency infra-production/cancel=false/queue=max также добавить существующему apply. `timeout-minutes: 60`. Запустить только нужный playbook; summary service/source/digest/run URL и desired/confirmed результат без secrets. Caller cancellation не отменяет remote apply.
- [ ] **Реализовать initialize:** явные два Release, проверенные тем же validator. На уже работающей VPS подтвердить Compose и реальные Config.Image/ImageID/health обоих; затем создать desired=confirmed. При отсутствующем Compose инициализация запрещена — новый VPS идёт через explicit bootstrap Task 2. При существующем state initialize идемпотентен только при полном совпадении, перезапись чужого состояния запрещена. Это отдельная административная операция один раз, не fallback каждого apply.
- [ ] **GREEN:** unit/contract tests и syntax обоих новых playbooks, actionlint. Если установленный actionlint ещё не знает queue:max, обновить проверенный pinned actionlint до версии с поддержкой, без blanket-disable правила; добавить проверку обоих concurrency blocks. Commit executor/docs/tests.

### Task 5: Caller после publisher с ожиданием настоящей выкладки

**Files:** `.github/scripts/auxiliary-cd.ts`, `tests/auxiliary-cd.test.ts`, `.github/workflows/auxiliary-cd.yml`, README, tests/lint.sh при необходимости.
**Interfaces:** `loadRelease(run: PublisherRun, api): Promise<Release>`, `dispatchAndWait(release: Release, requestId: string, api, clock): Promise<{run_id: number, html_url: string}>`; main читает event JSON/env. Только data artifact; checkout trusted default branch, никогда head-ref произвольного publisher.

- [ ] **RED:** fake HTTP/clock проверяет: source successful webhook-alerts не ждёт githubbot; wrong repo/event/branch/workflow/conclusion/attempt/artifact fields отказывают; absent/multiple/oversized release artifacts — отказ. Dispatch200 с workflow_run_id → ожидание именно этого run; success возвращает URL; failure/cancelled/timed_out/401/403/network error/time budget делают caller красным. HTTP204 не трактуется как success: отсутствие run ID — понятная ошибка протокола, никакого поиска первого похожего run. В тесте одновременно два сервиса получают разные run IDs.
- [ ] **Запустить:** `bun test tests/auxiliary-cd.test.ts`, получить RED.
- [ ] **Реализовать workflow_run:** workflows `[GitHubBot image, Webhook alerts image]`, types `[completed]`, branches `[main]`, явные trusted repo/event/conclusion guards; source GITHUB_TOKEN permissions contents:read/actions:read для artifact. Artifact выбрать по publisher_run_attempt и проверить поля с event, без исполнения содержимого. Bun stdlib и существующие способы zip extraction с ограничением одного известного файла; без нового package.
- [ ] **Реализовать dispatch:** отдельный secret `AUXILIARY_DEPLOY_TOKEN`, Actions:write только infra (+ обязательный Metadata:read), source-token не передавать в infra. API `2026-03-10` dispatch возвращает run ID/URL: проверить принадлежность нужному repo/workflow/event/ref и run-name с request_id; poll каждые 15 секунд до 120 минут, caller job timeout 130 минут. При неопределённом ответе не отправлять бесконечные повторы dispatch; ошибка и возможность rerun. Pending queue overflow/cancellation виден как failure caller. API rate limiting — учитывать Retry-After в пределах общего deadline. Summary связывает publisher и infra deployment.
- [ ] **GREEN:** Bun tests, workflow tests/lint. Документировать настройку отдельного секрета, expiration/renewal и ручной retry сохранённого release. Commit caller/tests/docs.

### Task 6: Интеграция, credentials и настоящая приёмка

**Files:** существующие README/RUNBOOK и эта acceptance checklist; реальные GitHub settings, CI и releases state. Не добавлять тестовую функциональность в приложения.
**Interfaces:** использует завершённые Tasks 1–5; исходное разрешение на план не заменяет отдельное разрешение на merge/deploy, если владелец ещё не дал его для этой новой работы.

- [ ] **Проверить интеграцию локально:** полные относящиеся suite обоих репозиториев, workflow lint/syntax, Docker smoke на реальных собранных образах. Проверить прохождение negative fixtures, retries и no-change соседнего сервиса. Не повторять уже зелёные suites без новой причины; task/final reviewers используют отчёты.
- [ ] **Подготовить два PR:** infra executor/state и `.github` publishers/caller (design+plan включить в source PR). Оба review/CI должны пройти. Для infra preview до initialize временно передать в существующий auxiliary check шаг `infra/.github/workflows/infra.yml` файл `--extra-vars @<runner-temp>/initial-releases.json` с `hooks_initial_releases` из проверенных фактических Release (без секретов): сверить с реальным Compose и trusted registry, ничего не записывать. Удалить этот временный CI migration-preview ввод после успешной initialize, не превращать его в постоянный fallback. Production missing state остаётся fail-closed.
- [ ] **Credentials:** проверить metadata источников без печати значений. Если токена нет, попросить владельца создать fine-grained PAT на infra с Actions read/write и сохранить локально в закрытый файл либо настроить repo secret `.github:AUXILIARY_DEPLOY_TOKEN` самостоятельно. Использовать `gh secret set ... < private-file`, не argv с токеном. Не менять runtime bot/Vault secrets. Тест реального dispatch подтверждает фактический доступ; наличие secret name недостаточно.
- [ ] **Ввести state:** после разрешённого merge infra запустить initialize с фактическими двумя pinned Release, полученными из текущего VPS Compose/доверенных прежних inventory/publisher runs. Не вписывать в план устаревающие конкретные SHA. Первая общая main-выкладка без state может fail-closed; после успешного initialize rerun. На пустом VPS сначала explicit verified bootstrap обоих образов через auxiliary.yml, затем обычная схема. Удалить migration-preview ввод после импорта; оба application pins отсутствуют.
- [ ] **Включить source CD:** после merge infra и настройки credentials влить source PR. Сами изменения publisher/helper запускают оба выпуска. Проверить две независимые цепочки publisher→caller→infra; exact desired=confirmed=runtime digest, единственный bot, здоровый alerts endpoint. Сохранить run URLs и actual SHA/digest в отчёт.
- [ ] **Проверить поведение:** повтор каждого publisher использует исходный digest; следующий выпуск только bot сохраняет alerts ID/image и наоборот (использовать следующий полезный release; не добавлять dummy runtime-фичи). Для немедленной acceptance допустим повторный deploy уже опубликованного одного сервиса с инспекцией неизменного соседа; реальное изменение digest обоих доказать initial automatic releases. Поставить оба CD и общий apply в одну очередь; убедиться, что каждый завершился и infra apply не откатил desired. Устаревший release отказал без изменения state.
- [ ] **Завершение:** не маскировать общий backend/BFF failure: отдельно назвать результат VPS3 CD и общего infra. Реальные Telegram команды проверяет пользователь; для CD не нужны сообщения/issue mutations. Обновить handoff и удалить только scratch выбранного execution plan после чистых review и приёмки.

## Self-review и источники

Spec coverage: CI/immutable outputs/path dependencies — T1; saved versions/bootstrap/recovery — T2–T4; targeted health/SQLite — T3; trust/order/queue — T4; dispatch/result — T5; actual credentials/migration/end-to-end — T6. Пять Review Focus имеют явные negative tests. Не добавлены rollout совместимости, сторонние image upgrades или новые уведомления.

Проверено через Context7 и официальные источники 2026-11-08:
- [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency): `queue: max`, не сочетать с cancel-in-progress:true; предел 100 pending.
- [workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run): отдельный запуск после publisher completion, не исполнять недоверенный artifact/code с secrets.
- [Dispatch REST](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event): версия API 2026-03-10 возвращает 200 с workflow_run_id/run_url/html_url. Поэтому план использует прямой ID вместо поиска по списку; request_id остаётся для сверки и трассировки. Это уточнение реализации, требование ждать реальную выкладку сохраняется.
