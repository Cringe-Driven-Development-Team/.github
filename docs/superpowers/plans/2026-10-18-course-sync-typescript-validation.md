# Course Sync TypeScript Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проверять provenance и обязательные CI jobs для course sync на TypeScript с точной диагностикой и ограниченным повтором чтения GitHub API.

**Architecture:** Локальное action в `.github` получает входы прежнего Bash-валидатора, читает GitHub REST API, проверяет фиксированную карту и отдаёт только `target`. TypeScript собирается в коммитнутый JavaScript для Node 24; reusable workflow вызывает action после checkout закреплённого `.github`, затем выполняет прежний Bash Git/SSH-шаг. Frontend и backend переключаются на новый полный SHA общей автоматики по очереди.

**Tech Stack:** TypeScript, Node 24, npm lockfile, esbuild, node:test через tsx, GitHub REST API, GitHub Actions, Bash, actionlint, shellcheck.

**Spec:** `docs/superpowers/specs/2026-10-18-course-sync-typescript-validation-design.md` (в этом же репозитории).

## Global Constraints

- Runtime sync-job — Node 24 с готовым JavaScript; Bun, `npm install` и сборки во время sync нет.
- `scripts/course-sync-git.sh`, Git/SSH/очистка ключа и Bash-уведомления сохраняют поведение; расширять права `GITHUB_TOKEN` нельзя (`actions: read`, `contents: read`).
- Источники и назначения фиксированы: `Cringe-Driven-Development-Team/frontend` → `frontend-park-mail-ru/2026_2_Cringe_Driven_Development`, `Cringe-Driven-Development-Team/backend` → `go-park-mail-ru/2026_2_Cringe_Driven_Development`.
- Успешный push/main CI должен иметь точный SHA и workflow `.github/workflows/ci.yml`; frontend требует `Check`, backend — `lint`, `test`, `docker`; job-only rerun учитывает последнюю попытку каждого job.
- Общий срок повторов — не более 60 секунд, пауза между ними — не более 5 секунд, каждый HTTP-запрос — не более 10 секунд. Неверный формат входа и завершившийся неуспешно обязательный job отклоняются без ожидания.
- В обоих caller-репозиториях `uses` и `automation_ref` должны содержать один полный SHA `.github` и в CI, и в ручном sync workflow. Deploy/upload ради восстановления sync не перезапускать.

## Review Focus

- HTTP 200 с `null`, массивом или не-JSON вместо run: Task 2/3 отвергает ответ с указанием поля, output пуст.
- Дубли job в одной попытке или страницах API: Task 1/2 отвергает неоднозначность, не выбирает удобный успешный job.
- `head_repository` отсутствует при первом чтении, затем появляется: Task 3 повторяет всю проверку до срока и выдаёт target только после полного совпадения.
- HTTP 401/403, 429/5xx и таймаут: Task 2/3 различает постоянный отказ и временный сбой, не пишет токен в лог и не превышает срок.
- Номер попытки меняется между чтением jobs и повторным чтением run: Task 3 отбрасывает снимок, начинает заново, не пишет target из старой попытки.

## Карта файлов

| Репозиторий и файл | Ответственность |
|---|---|
| `.github` repo: `actions/course-sync-context/{package.json,package-lock.json,tsconfig.json,action.yml}` | Dev-зависимости, проверка типов, Node 24 entry и output `target` |
| `.github` repo: `actions/course-sync-context/src/policy.ts` | Формат входов, фиксированная карта, проверки run/workflow/jobs и конкретные ошибки |
| `.github` repo: `actions/course-sync-context/src/api.ts` | GitHub REST, таймаут, полная пагинация, классификация HTTP-ошибок |
| `.github` repo: `actions/course-sync-context/src/verify.ts` | Повторы до срока, повторное чтение run и запрет output до полного успеха |
| `.github` repo: `actions/course-sync-context/src/main.ts`, `dist/main.js` | Action entry и воспроизводимый исполняемый артефакт без runtime-зависимостей |
| `.github` repo: `actions/course-sync-context/test/{policy,api,verify,main}.test.ts` | Фикстуры и проверка границ без сети и записи в учебные репозитории |
| `.github` repo: `.github/workflows/{sync-to-course,checks}.yml`, `tests/course-sync-workflow.sh`, `README.md` | Подключение action, CI сборки, структурные тесты и инструкция; удалить старые `scripts/course-sync-context.sh` и `tests/course-sync-context.sh` |
| `frontend/.github/workflows/{ci,sync-to-course}.yml`, `backend/.github/workflows/{ci,sync-to-course}.yml` | Отдельные caller PR с обновлением двух закреплённых SHA в каждом файле |

---

### Task 1: Политика доверия и выбор обязательных jobs

**Files:** Create `actions/course-sync-context/{package.json,package-lock.json,tsconfig.json,src/policy.ts,test/policy.test.ts}`.

**Interfaces:** `SourceRepo` и `TargetRepo` — union двух фиксированных исходных и учебных репозиториев. `Candidate={sourceRepo:SourceRepo,runId:number,sha:string,target:TargetRepo,requiredJobs:readonly string[]}`; `RunSnapshot={id:number,attempt:number,sha:string,sourceRepo:SourceRepo,workflowId:number,event:"push",headBranch:"main"}`. `parseCandidate({sourceRepo:string,runId:string,sha:string}):Candidate`; `verifyRun(run:unknown,workflow:unknown,candidate:Candidate):RunSnapshot`; `verifyJobs(jobsByAttempt:ReadonlyMap<number,readonly unknown[]>,snapshot:RunSnapshot,requiredJobs:readonly string[]):void`; `assertSameRun(before:RunSnapshot,after:unknown):void`. Ошибки `InputError` и `CheckError {field,expected,actual,retryable}` экспортируются для Task 3.

- [ ] **Step 1: Добавить package/lockfile и npm scripts для Node 24.** Dev-зависимости `typescript`, `tsx`, `esbuild`, `@types/node` установить с `--save-exact`; scripts: `test=tsx --test`, `typecheck=tsc --noEmit`, `build=esbuild src/main.ts --bundle --platform=node --target=node24 --format=esm --outfile=dist/main.js`; runtime-зависимостей нет.
- [ ] **Step 2: Написать падающие `policy.test.ts`.** Названия случаев: `valid_backend_target_and_jobs`, `valid_frontend_check`, `invalid_input`, `wrong_run_field`, `ambiguous_or_failed_job`, `latest_attempt_wins`, `run_changed`. Ключевые утверждения:

  ```ts
  assert.deepEqual(parseCandidate({sourceRepo:"Cringe-Driven-Development-Team/backend",runId:"101",sha:"a".repeat(40)}).requiredJobs, ["lint","test","docker"]);
  assert.equal(parseCandidate({sourceRepo:"Cringe-Driven-Development-Team/frontend",runId:"101",sha:"a".repeat(40)}).target, "frontend-park-mail-ru/2026_2_Cringe_Driven_Development");
  assert.throws(() => verifyRun({...validRun,head_sha:"wrong"}, validWorkflow, candidate), /head_sha/);
  ```
- [ ] **Step 3: Выполнить `npm test -- test/policy.test.ts` в каталоге action.** Ожидается FAIL из-за отсутствующих экспортов `policy.ts`.
- [ ] **Step 4: Реализовать интерфейсы `policy.ts`.** Не принимать произвольный target; `run_attempt` — положительное целое; `verifyJobs` идёт от `snapshot.attempt` к первой попытке, один результат каждого обязательного имени на попытку, последний найденный результат должен быть completed/success.
- [ ] **Step 5: Выполнить `npm test -- test/policy.test.ts` и `npm run typecheck`.** Ожидается PASS.
- [ ] **Step 6: Закоммитить файлы Task 1.** В коммите только package/lockfile, tsconfig, policy и его тест.

### Task 2: REST-клиент и полная пагинация

**Files:** Create `actions/course-sync-context/src/api.ts`, `test/api.test.ts`.

**Interfaces:** `GitHubApi` с `getRun(repo,runId):Promise<unknown>`, `getWorkflow(repo):Promise<unknown>`, `getAttemptJobs(repo,runId,attempt):Promise<readonly unknown[]>`; `createGitHubApi(token:string,fetchImpl:typeof fetch=fetch,timeoutMs:number=10_000):GitHubApi`. `ApiError {status,retryable}` и `IncompleteJobsError` экспортируются для Task 3.

- [ ] **Step 1: Написать падающие `api.test.ts` с подставным `fetch`.** Названия случаев: `fetches_expected_endpoints`, `paginates_all_jobs`, `rejects_incomplete_or_duplicate_pages`, `rejects_malformed_json`, `classifies_http_errors`, `times_out_at_ten_seconds`. Ключевые утверждения:

  ```ts
  assert.deepEqual(await api.getAttemptJobs(repo, 101, 1), [job1, job2]);
  await assert.rejects(api.getRun(repo, 101), /HTTP 401/);
  ```
- [ ] **Step 2: Выполнить `npm test -- test/api.test.ts`.** Ожидается FAIL из-за отсутствующего `createGitHubApi`.
- [ ] **Step 3: Реализовать `api.ts`.** Использовать `Authorization: Bearer`, `Accept: application/vnd.github+json`, `AbortSignal.timeout(10_000)`; собирать страницы до `total_count`, не возвращать неполный или неоднозначный список.
- [ ] **Step 4: Выполнить `npm test -- test/api.test.ts` и `npm run typecheck`.** Ожидается PASS.
- [ ] **Step 5: Закоммитить файлы Task 2.** В коммите только REST-клиент и его тест.

### Task 3: Повторы, entry point и артефакт Node 24

**Files:** Create `actions/course-sync-context/{action.yml,src/verify.ts,src/main.ts,dist/main.js,test/verify.test.ts,test/main.test.ts}`; update `package.json` scripts.

**Interfaces:** `Clock={now():number,sleep(ms:number):Promise<void>}`; `verifyCandidate(candidate:Candidate,api:GitHubApi,clock:Clock):Promise<TargetRepo>`; `executeAction(env:NodeJS.ProcessEnv,api:GitHubApi,clock:Clock,writeOutput:(line:string)=>void):Promise<void>`. `action.yml` объявляет output `target`, `runs.using: node24`, `runs.main: dist/main.js`; entry читает `SOURCE_REPO`, `CI_RUN_ID`, `SHA`, `GH_TOKEN` из окружения и записывает `target=<fixed-target>` в `GITHUB_OUTPUT` только после полного успеха.

- [ ] **Step 1: Написать падающие `verify.test.ts` и `main.test.ts`.** Названия случаев: `valid_run_returns_target`, `missing_head_repository_then_valid`, `timeout_reports_last_field`, `incomplete_jobs_then_complete`, `attempt_changes_during_read`, `failed_job_and_401_do_not_retry`, `rate_limit_retries`, `failure_never_writes_output`. Ключевые утверждения:

  ```ts
  assert.equal(await verifyCandidate(candidate, transientApi, fakeClock), candidate.target);
  await assert.rejects(verifyCandidate(candidate, alwaysWrongApi, fakeClock), /head_repository/);
  assert.deepEqual(writtenOutput, []); // после отказа, включая недоступный GITHUB_OUTPUT
  ```
- [ ] **Step 2: Выполнить `npm test -- test/verify.test.ts test/main.test.ts`.** Ожидается FAIL из-за отсутствующих `verifyCandidate`/`executeAction`.
- [ ] **Step 3: Реализовать `verify.ts` и `main.ts`; добавить `action.yml` и сборку `dist/main.js`.** В пределах 60 секунд заново читать run/workflow/jobs при `CheckError.retryable`, `IncompleteJobsError`, 429/5xx; не повторять InputError, 401/403 и failed required job. После jobs снова читать run; при смене идентичности/attempt отбросить снимок. Писать последнее конкретное условие без токена или полного JSON.
- [ ] **Step 4: Выполнить `npm test`, `npm run typecheck`, `npm run build`.** Ожидается PASS.
- [ ] **Step 5: Закоммитить файлы Task 3 вместе с `dist/main.js`.** В коммите entry, retry, action metadata, собранный JavaScript и тесты.

### Task 4: Подключить action к reusable workflow

**Files:** Modify `.github/workflows/sync-to-course.yml`, `tests/course-sync-workflow.sh`, `README.md`; create `.github/workflows/checks.yml`; delete `scripts/course-sync-context.sh`, `tests/course-sync-context.sh`.

**Interfaces:** Шаг `id: context` использует `./automation/actions/course-sync-context` и отдаёт прежний `${{ steps.context.outputs.target }}` следующему Bash-шагу. Caller inputs, permissions, checkout `automation_ref`, Git/SSH и уведомления сохраняются.

- [ ] **Step 1: Обновить `tests/course-sync-workflow.sh` так, чтобы до правки YAML он падал.** Проверить путь `uses: ./automation/actions/course-sync-context`, `id: context`, output `${{ steps.context.outputs.target }}`, прежние permissions/входы и checkout по `automation_ref`; перенумеровать два оставшихся проверяемых `run: |` блока после замены шага проверки.
- [ ] **Step 2: Выполнить `bash tests/course-sync-workflow.sh`.** Ожидается FAIL: локальный action ещё не вызывается.
- [ ] **Step 3: Заменить шаг проверки на локальный action, удалить прежний Bash-валидатор/его тесты, обновить README.** Сохранить `GH_TOKEN: ${{ github.token }}` у шага action. Добавить `checks.yml` для PR/push main: в `actions/course-sync-context` выполнить `npm ci`, `npm test`, `npm run typecheck`, `npm run build`; из корня выполнить `git diff --exit-code -- actions/course-sync-context/dist/main.js`, Bash Git-тест и workflow-тест; не передавать sync/production secrets.
- [ ] **Step 4: Выполнить action tests, `bash tests/course-sync-workflow.sh`, `bash tests/course-sync-git.sh`, `bash tests/lint.sh`, `git diff --check`.** Ожидается PASS, включая actionlint и shellcheck.
- [ ] **Step 5: Закоммитить файлы Task 4.** В коммите workflow, CI, README и удаление прежнего валидатора/теста.
- [ ] **Step 6: Открыть PR `.github`.** В описании объяснить прежний общий provenance-отказ и связать существующую задачу, если она есть; при создании новой межрепозиторной задачи применять правило `Part of` из `CONTRIBUTING.md`, чтобы первый PR не закрыл её до переключения обоих callers.
- [ ] **Step 7: Проверить PR CI, актуальный head и отсутствие конфликтов.** Ожидается зелёный `checks.yml`.
- [ ] **Step 8: Слить PR по правилам репозитория.** Зафиксировать полный merge SHA для caller-обновлений; старые callers ещё указывают на старый SHA.

### Task 5: Переключить frontend caller

**Files:** Modify `frontend/.github/workflows/ci.yml`, `frontend/.github/workflows/sync-to-course.yml`.

**Interfaces:** `uses` и `automation_ref` в обоих frontend файлах указывают на один полный SHA `.github` из Task 4; `needs: [check]`, secrets и условия job не меняются.

- [ ] **Step 1: В свежем checkout frontend проверить, что четыре старых SHA отличаются от merge SHA Task 4.** Ожидается найденный старый `265e6cd1e7b2625cee5606ddd67db66a04f8682e`; не редактировать занятый checkout другого задания.
- [ ] **Step 2: Заменить четыре значения SHA на полный merge SHA Task 4.** Иных строк в двух workflow не менять.
- [ ] **Step 3: Выполнить `actionlint` и проверить равенство четырёх значений `uses`/`automation_ref`.** Ожидается PASS.
- [ ] **Step 4: Закоммитить frontend-правку.** В коммите только два caller workflow.
- [ ] **Step 5: Открыть frontend PR.** Описание указывает `Part of` общей задачи, если она заведена.
- [ ] **Step 6: Проверить актуальный head, обязательный CI и отсутствие конфликтов.** Ожидается зелёный PR.
- [ ] **Step 7: Слить frontend PR по правилам репозитория.** Зафиксировать merge SHA.
- [ ] **Step 8: Проверить push/main `Check`, upload (если запускался), course-sync и равенство SHA командного/учебного `main`.** При сбое sync использовать отдельный ручной workflow с CI run ID, без повторного upload.

### Task 6: Переключить backend caller

**Files:** Modify `backend/.github/workflows/ci.yml`, `backend/.github/workflows/sync-to-course.yml`.

**Interfaces:** `uses` и `automation_ref` в обоих backend файлах указывают на тот же полный SHA `.github` из Task 4; `needs: [lint,test,docker]`, secrets и условия job не меняются.

- [ ] **Step 1: В свежем checkout backend проверить четыре старых SHA и актуальный `main`.** Ожидается прежний `265e6cd1e7b2625cee5606ddd67db66a04f8682e`; не редактировать ветку `api-37` предыдущего задания.
- [ ] **Step 2: Заменить четыре значения SHA на полный merge SHA Task 4.** Иных строк в двух workflow не менять.
- [ ] **Step 3: Выполнить `actionlint` и проверить равенство четырёх значений `uses`/`automation_ref`.** Ожидается PASS.
- [ ] **Step 4: Закоммитить backend-правку.** В коммите только два caller workflow.
- [ ] **Step 5: Открыть backend PR.** Описание указывает `Part of` общей задачи, если она заведена.
- [ ] **Step 6: Проверить актуальный head, обязательные `lint/test/docker` и отсутствие конфликтов.** Ожидается зелёный PR.
- [ ] **Step 7: Слить backend PR по правилам репозитория.** Зафиксировать merge SHA.
- [ ] **Step 8: Проверить push/main CI, deploy, course-sync и равенство SHA командного/учебного `main`.** При сбое sync использовать отдельный ручной workflow с CI run ID, без повторного deploy.

После Task 6 итоговый отчёт должен отдельно указать SHA и результат `.github` PR, обоих caller PR, post-merge CI и course-sync, а также совпадение каждой учебной копии с соответствующим командным `main`.
