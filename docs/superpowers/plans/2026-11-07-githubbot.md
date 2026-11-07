# GitHubBot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать команде семь Telegram-команд для GitHub Issues и текущего Sprint с назначением по Telegram-пингу и ответами на существующие карточки.

**Architecture:** Отдельный `services/githubbot` принимает Telegram updates через long polling. GitHub хранит задачи и спринты; локальная SQLite хранит команды, выбор репозитория и результаты, позволяя переживать повторную доставку и перезапуск. Отдельный infra-план доставляет образ на auxiliary через существующий Compose/proxy.

**Tech Stack:** Bun 1.4.4, TypeScript 5.9.3, `@types/bun` 1.4.4, `bun:sqlite`, встроенный `fetch`, GitHub REST/GraphQL, Telegram Bot API; без новых runtime-зависимостей.

**Spec:** [2026-11-07-githubbot-design.md](../specs/2026-11-07-githubbot-design.md). Читать перед планом. Задача [.github#60](https://github.com/Cringe-Driven-Development-Team/.github/issues/60), инфраструктурная sub-issue [infra#111](https://github.com/Cringe-Driven-Development-Team/infra/issues/111). Её план находится в репозитории infra: `docs/superpowers/plans/2026-11-07-githubbot-deploy.md`, текущий checkout `/home/oleg/2026_H2/.infra-githubbot-plan`.

## Global Constraints

- Имя продукта — **GitHubBot**; файлы, сервис и image — `githubbot`.
- «GitHub Issues и проект Scrumban №1 организации Cringe-Driven-Development-Team остаются источником данных»; поле `Sprint`, зона `Europe/Moscow`.
- «Backend → backend», «Frontend → frontend», «UX → figma»; маршрутизация по chat/topic ID, остальные топики — кнопки.
- «Issue появляется в Scrumban со статусом `Backlog` и пустым `Sprint`»; автоматического assignee нет.
- «`/tosprint` обеспечивает членство issue в проекте и записывает только Sprint»; существующий Status не перезаписывается.
- «Если заданы оба способа, просит оставить один, даже когда ссылки совпадают» — reply и явный URL.
- «Выбор принимает только от автора исходной команды»; кнопки живут 24 часа.
- Все настроенные участники имеют одинаковые права в разрешённой группе; identity — Telegram ID, alias — настроенный username.
- `/sprint` включает завершённые неархивированные Issues; PR/drafts исключаются. Без assignee — отдельная группа.
- Не выполнять shell из сообщений, не копировать GitHubBot upstream, не вводить OAuth, LLM, новые облачные ресурсы или базу задач.
- Не выполнять live-команды/деплой на этапе написания плана. Не обещать exactly-once POST создания issue.

## Review Focus

1. Emoji перед ссылкой, несколько `text_link` и ссылки в blockquote: выбрать только цель основной карточки по UTF-16 offsets — тест Task 1.
2. Callback от чужого автора, из другого сообщения или повторный после перезапуска: не создать issue — тест Tasks 4–5.
3. GitHub принял POST, но соединение оборвалось: не повторять создание и не заявлять успех — тест Tasks 2, 4–5.
4. Чужое изменение Status во время `/tosprint`: записать только Sprint, показать несовпадение без восстановления чужого значения — тест Task 3.
5. Смена Telegram username и повторная выдача старого alias: блокировать обнаруженный устаревший alias после рестарта; ID-авторизация и `/assignme` сохраняются — тест Tasks 4–5. Необнаруженная смена требует обновления конфигурации владельцем.

---

## Объём, порядок и файлы

Семь задач сервиса выполняются последовательно. Infra может параллельно работать с согласованным контейнерным контрактом, но живую приёмку выполняет после публикации образа. Способ исполнения ещё **не выбран**: не начинать реализацию до ответа владельца.

| Путь | Ответственность |
| --- | --- |
| `services/githubbot/src/config.ts` | Проверка окружения, repo/user/topic allowlists. |
| `services/githubbot/src/commands.ts` | Разбор Telegram, команд, карточек и ссылок; типы входа. |
| `services/githubbot/src/github.ts` | REST Issues, assignees и ошибки транспорта. |
| `services/githubbot/src/projects.ts` | GraphQL, Sprint, пагинация и чтение результата. |
| `services/githubbot/src/messages.ts` | HTML-карточки, кнопки, сводки и разбиение сообщений. |
| `services/githubbot/src/store.ts` | SQLite, durable intake, заявки выбора, этапы и invalid aliases. |
| `services/githubbot/src/handler.ts` | Выполнение одной сохранённой команды, callbacks и частичные успехи. |
| `services/githubbot/src/telegram.ts` | Bot API, proxy, отправка сообщений/answerCallbackQuery. |
| `services/githubbot/src/main.ts` | CLI, startup, polling/worker, shutdown, heartbeat. |
| `services/githubbot/tests/*.test.ts`, `tests/fixtures.ts` | Тесты публичных интерфейсов с временной SQLite/поддельным fetch. |
| `services/githubbot/{package.json,bun.lock,tsconfig.json,Dockerfile,Dockerfile.dockerignore,README.md,config.example.json}` | Запуск, типы, образ и инструкция; создаются с потребляющей задачей. |
| `.github/workflows/checks.yml`, `githubbot-image.yml` | Проверки и публикация сервиса. |
| `tests/githubbot-workflows.test.ts`, `tests/githubbot-docker.sh` | Контракт CI/image и контейнерная проверка. |
| `README.md` | Добавление сервиса и его локальных команд. |

Пути выше относительно корня `.github`. Не трогать существующие webhook handlers, release logic и `scripts/sprint.sh`. Из `services/webhook-alerts/src/format.ts` импортировать только чистые `escapeHtml`, `link`, `mention`; `fitHtml` обрезает текст и не годится для сводки без потери строк. Docker context — корень repo, чтобы включить этот файл.

### Общий контракт процесса для infra

Environment: `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `GITHUBBOT_CONFIG_JSON`, `DATABASE_PATH=/data/githubbot.sqlite`, необязательный `TELEGRAM_PROXY_URL` (только запросы Telegram). `GITHUBBOT_CONFIG_JSON` содержит `chatId`, `notificationBotIds`, `repositories: [{name,defaultPrefix,prefixes}]`, `topics: [{threadId,repository}]`, `users: [{telegramId,username,githubLogin}]`. В одной конфигурации одна группа. Положительные Telegram ID и отрицательный group ID хранить decimal strings; threadId — положительный safe integer. ID полей проекта получают из API.

CLI `bun run src/main.ts`: polling/worker; `--check-config`: локальная проверка без сети/SQLite; `--health`: exit 0 при свежем heartbeat (не старше 120 секунд), иначе 1. Heartbeat `/data/health.json` обновляется после успешного poll и между этапами; успешный старт с невалидным токеном невозможен. Image — `ghcr.io/cringe-driven-development-team/githubbot:sha-<full SHA>`, запуск non-root `bun`, volume `/data`, без EXPOSE/HTTP listener. Контейнер сам содержит config checker и health checker.

### Task 1: Конфигурация, команды и доверенные карточки

**Files:** Create `services/githubbot/{package.json,tsconfig.json,bun.lock,config.example.json}`, `src/{config,commands}.ts`, `tests/{fixtures,commands.test}.ts`.

**Interfaces:**
- Produces `loadConfig(env: Record<string,string|undefined>): Config` в config.ts. Config содержит поля JSON контракта и `telegramToken:string`, `githubToken:string`, `databasePath:string`, `telegramProxyUrl?:string`. `RepoConfig`, `UserConfig`, `BotIdentity {id:string;username:string}` экспортируются там же.
- Produces `IssueRef {repo:string;number:number;url:string}`, `Context {chatId:string;threadId?:number;messageId:number}`, `Actor {id:string;username?:string}` в commands.ts.
- Produces `Command = {name:'issue';title:string;body:string} | {name:'sprint';username?:string} | {name:'close'|'assign'|'assignme'|'unassign'|'tosprint';target:IssueRef;username?:string}`.
- Produces `Input = {updateId:number;context:Context;actor:Actor} & ({kind:'command';command:Command} | {kind:'choice';requestId:string;repoIndex:number;callbackId:string;promptMessageId:number} | {kind:'error';message:string;callbackId?:string})`.
- Produces `decodeUpdate(raw:unknown, config:Config, bot:BotIdentity): Input|null`, `normalizeTitle(title:string, repo:RepoConfig, repos:RepoConfig[]):string`, `parseIssueUrl(url:string, config:Config):IssueRef`. Неизвестная команда/другой адресат/edited update → null; ошибка аргументов известной команды → `CommandError {message:string;context:Context;actor:Actor;updateId:number;callbackId?:string}` без записи GitHub.
- Test fixtures produces `config():Config`, `bot:BotIdentity`, `message(text:string, reply?:unknown):unknown`, `callback(requestId:string, repoIndex:number, actorId?:string):unknown`. Фиктивные IDs: chat `-1001`, actor `101`/username `alice`/login `octo`, notification bot `900`, bot `901`, topics 11 backend / 12 frontend / 13 figma; unknown topic 14. Fixture factory returns complete raw Update; optional modifications делать внутри конкретного теста.

- [ ] **Step 1: Написать failing tests** `commands.test.ts` с импортами будущих функций и тестовыми fixtures (это часть задачи, не production scaffold).

```ts
test('repo prefixes and raw description', () => {
  const c = config(), r = c.repositories.find(x => x.name === 'frontend')!;
  expect(normalizeTitle('Форма', r, c.repositories)).toBe('Frontend. Форма');
  expect(normalizeTitle('BFF. Сессия', r, c.repositories)).toBe('BFF. Сессия');
  expect(() => normalizeTitle('Backend. Сессия', r, c.repositories)).toThrow();
  expect(decodeUpdate(message('/issue Форма\n**Описание**'), c, bot))
    .toMatchObject({command:{name:'issue',title:'Форма',body:'**Описание**'}});
});
```

Добавить test.each для пяти изменяющих команд: reply/URL дают одинаковый IssueRef; ни одного/оба/#N → CommandError; `/sprint` без target работает. Прямо assert для HTTPS userinfo, evil host, чужой org/repo и `/pull/1`: `toThrow()`. Поддельный notification sender/forward_origin → ошибка. В карточке с emoji, header entity и другой ссылкой в blockquote выбрать header; header/button с разными issue → ошибка; одинаковые → одна цель. Поправить UTF-16 offset в fixture реальным `text.indexOf(...)`, а не количеством code points. Чужой bot suffix и edited_message → null. Duplicate users/repos, пустые credentials, нечисловые ID → ошибка без echo токена.

- [ ] **Step 2: Запустить красную проверку:** `bun test services/githubbot/tests/commands.test.ts` → FAIL из-за отсутствующего production-модуля.
- [ ] **Step 3: Реализовать указанные интерфейсы.** Оригинал карточки должен быть `reply_to_message` в том же чате/топике; доверенные IDs только config и getMe. Header link — entity вне blockquote на строке `repo#N`/`#N`; кнопки только канонические task/comment links. Не выполнять fetch произвольной ссылки. Добавить package scripts `start`, `test`, `typecheck`; dev versions как в Tech Stack, TS strict/noUncheckedIndexedAccess как у webhook-alerts. Пример config — только фиктивные значения.
- [ ] **Step 4: Проверить:** `bun test services/githubbot/tests/commands.test.ts`; `(cd services/githubbot && bun install && bun run typecheck)` → PASS; зафиксировать bun.lock.
- [ ] **Step 5: Commit:** `git add services/githubbot && git commit -m "feat: parse GitHubBot commands and validate access configuration"`.

### Task 2: GitHub Issues без потери исполнителей

**Files:** Create `src/github.ts`, `tests/github.test.ts`.

**Interfaces:** Consumes Config, IssueRef. Produces `Issue {ref:IssueRef;nodeId:string;title:string;state:'OPEN'|'CLOSED';assignees:string[]}`; `createGithub(config:Config, fetcher:typeof fetch): Github`.
`Github`: `getIssue(ref):Promise<Issue>`, `createIssue(repo:string,title:string,body:string):Promise<Issue>`, `canAssign(repo:string,login:string):Promise<boolean>`, `addAssignee(ref,login):Promise<Issue>`, `removeAssignee(ref,login):Promise<Issue>`, `closeIssue(ref):Promise<Issue>` (ref/login типы IssueRef/string).
Produces `ApiError` с `provider:'github'|'telegram'`, `kind:'rejected'|'retryable'|'uncertain'`, optional `retryAfterMs:number`; использовать также в Telegram adapter.

- [ ] **Step 1: Написать тесты на fake fetch**, собирающий запросы в массив `calls: {url:string;method:string;body:unknown}[]` (локальный fixture в этом файле). Создание отправляет title/body и не отправляет assignees. `/issues/N` с `pull_request` отвергается. `canAssign`: 204 true, 404 false, 403 ошибка. Добавление POST и удаление DELETE `/assignees` передают только целевой login; возвращённое/readback множество сохраняет остальных. Close PATCH содержит `{state:'closed',state_reason:'completed'}`. Транспортная ошибка create → ApiError.kind uncertain и ровно один вызов; 422 → rejected. Redirect на другой URL не выполняется с credentials; GraphQL HTTP-200 errors будут проверяться Task 3.

```ts
// Внутри fake-fetch теста addAssignee:
expect(calls.filter(x => x.method === 'POST').map(x => x.body))
  .toEqual([{assignees:['octo']}]);
expect(result.assignees).toEqual(['existing','octo']);
// В тесте неоднозначного создания:
await expect(api.createIssue('backend','Backend. X','')).rejects.toMatchObject({kind:'uncertain'});
expect(calls).toHaveLength(1);
```

- [ ] **Step 2:** `bun test services/githubbot/tests/github.test.ts` → FAIL на missing module/API.
- [ ] **Step 3: Реализовать Github.** Только фиксированный `api.github.com`, redirects manual, timeout 15 секунд. Для create не делать скрытых retries; сетевые сбои и сомнительный 5xx после отправки → uncertain. 429/rate-limit response содержит задержку, но retry решает handler. Прочитать результат после mutation; getIssue защищает от PR. Повторное close/add/remove существующего состояния — без лишней записи.
- [ ] **Step 4:** `bun test services/githubbot/tests/github.test.ts`; `bun run --cwd services/githubbot typecheck` → PASS.
- [ ] **Step 5:** `git add services/githubbot && git commit -m "feat: add GitHub issue operations with checked outcomes"`.

### Task 3: Projects Sprint и сводки

**Files:** Create `src/{projects,messages}.ts`, `tests/projects.test.ts`, `tests/messages.test.ts`.

**Interfaces:** Consumes Config, Issue, IssueRef, ApiError. Produces `Iteration {id:string;title:string;startDate:string;duration:number}`, `ProjectItem {id:string;issue:Issue;archived:boolean;sprintId:string|null;status:string|null}`, `Board {id:string;sprintFieldId:string;statusFieldId:string;backlogOptionId:string;iterations:Iteration[];items:ProjectItem[]}`.
- `currentIteration(iterations:Iteration[], now:Date):Iteration`;
- `createProjects(config:Config,fetcher:typeof fetch):Projects`, где `readBoard():Promise<Board>`, `initializeIssue(issue:Issue):Promise<ProjectItem>`, `toCurrentSprint(issue:Issue,now:Date):Promise<{item:ProjectItem;iteration:Iteration;statusChangedExternally:boolean}>`;
- `Outgoing {html:string;keyboard?:{text:string;url?:string;callback_data?:string}[][]}`;
- `issueCard(issue:Issue,result:string):Outgoing`, `repositoryPrompt(requestId:string,repos:RepoConfig[]):Outgoing`, `sprintMessages(board:Board,iteration:Iteration,users:UserConfig[],login?:string):Outgoing[]`.

- [ ] **Step 1: Написать failing tests** с Iteration Sprint 8 (2026-11-02, 7 дней) и Sprint 9 (2026-11-09, 7 дней).

```ts
expect(currentIteration(iterations,new Date('2026-11-08T20:59:59Z')).title).toBe('Sprint 8');
expect(currentIteration(iterations,new Date('2026-11-08T21:00:00Z')).title).toBe('Sprint 9');
expect(() => currentIteration([],new Date('2026-11-07T00:00:00Z'))).toThrow();
```

В fake GraphQL тестах: две страницы items и fields полностью прочитаны; optional null content/PR/draft исключены; HTTP 200 с `errors` → rejected. initializeIssue повторно использует существующий item, записывает Backlog, очищает Sprint и делает readback. toCurrentSprint не отправляет Status mutation, при внешней смене возвращает `statusChangedExternally:true`, при пустом Status сохраняет null; нет текущей/две текущих итерации → ни одной mutation. Новый item добавляется только после успешного определения спринта. Проверить закрытый issue и перенос из другой итерации.
В messages tests собрать 150 Issues с несколькими assignees, CLOSED+In progress, без assignee, null Status, неизвестным GitHub login и названием `<b>&😀`: все строки сохранены, unique count не удваивается, личный фильтр точен, HTML экранирован, каждое сообщение ≤4096 UTF-16 units и содержит целые ссылки. Empty → «задач нет».

- [ ] **Step 2:** `bun test services/githubbot/tests/projects.test.ts services/githubbot/tests/messages.test.ts` → FAIL.
- [ ] **Step 3: Реализовать интерфейсы.** Взять запросы/пагинацию из `scripts/sprint.sh`, не вызывать скрипт. Сравнивать календарные даты Moscow, а не `now+7*24h` в локальной зоне. Чтение iterations включает completedIterations; обнаружение по датам. ID полей ищутся по имени и типу. В сводках deterministic order login, затем repo/number. Разбивать по строкам с повтором заголовка группы; длинную одиночную строку разбить безопасно, не теряя ссылку/задачу. Prefix и доверенные карточки совпадают с Task 1.
- [ ] **Step 4:** команды Step 2 плюс `bun run --cwd services/githubbot typecheck` → PASS.
- [ ] **Step 5:** `git add services/githubbot && git commit -m "feat: manage current Sprint and render team summaries"`.

### Task 4: Durable intake, заявки и журнал выполнения

**Files:** Create `src/store.ts`, `tests/store.test.ts`.

**Interfaces:** Consumes Input, Issue, Context, Outgoing. Produces `openStore(path:string):Store` и `Job {id:number;input:Input;phase:Phase;issue?:Issue;output?:Outgoing[];nextOutput:number;nextAttemptAt:number;attempts:number;selectedRepo?:string;choiceId?:string}`.
`Phase = 'received'|'waiting_repo'|'ready'|'creating'|'issue_created'|'mutating'|'reply_pending'|'done'|'uncertain'`.
Store methods: `ingest(inputs:Input[], nextOffset:number):void`, `offset():number`, `job(id:number):Job`, `nextJob(now:number):Job|null`, `checkpoint(id:number,patch:Partial<Pick<Job,'phase'|'issue'|'output'|'nextOutput'|'nextAttemptAt'|'attempts'|'selectedRepo'|'choiceId'>>):void`, `createChoice(jobId:number,repoNames:string[],expiresAt:number):string`, `bindPrompt(requestId:string,messageId:number):void`, `choose(requestId:string,actorId:string,context:Context,promptMessageId:number,repoIndex:number,now:number):number`, `blockAlias(id:string,configuredUsername:string):void`, `isAliasBlocked(id:string,configuredUsername:string):boolean`, `recover():void`, `close():void`.
choose возвращает original jobId и сохраняет repoNames[repoIndex] как selectedRepo исходного job. createChoice сохраняет choiceId на job. Проверяются chatId/threadId, actor и отдельный promptMessageId; messageId исходной команды и callback закономерно различаются. Prompt choice имеет owner/chat/topic/authoritative repo list из repoNames, переданного в createChoice; обработчик перепроверяет repo allowlist после рестарта. Повторный callback возвращает тот же jobId, не создаёт job создания. `recover` переводит оставшийся creating без Issue в uncertain, mutating — в ready для read-before-write.

- [ ] **Step 1: Написать failing tests** с временным SQLite-файлом: ingest rollback при ошибке не двигает offset, повтор updateId не добавляет job, reopening сохраняет jobs/choice/offset. nextJob не возвращает waiting_repo/done или future nextAttemptAt; uncertain возвращается только для доставки ещё не отправленного предупреждения. recover записывает предупреждающий output, никогда не переводит uncertain в ready.

```ts
store.ingest([input],input.updateId+1);
store.ingest([input],input.updateId+1);
expect(store.nextJob(0)?.id).toBe(input.updateId);
store.checkpoint(input.updateId,{phase:'creating'});
store.close();
store = openStore(path); store.recover();
expect(store.job(input.updateId).phase).toBe('uncertain');
expect(store.job(input.updateId).output?.length).toBeGreaterThan(0);
```

Добавить assert выбора после 24h, другим actor, другим prompt/chat/topic или repoIndex вне списка → отказ без перехода original job. Две заявки одного actor независимы; двойной choose связывает только одну. blockAlias survives reopen и key содержит старое configuredUsername, поэтому исправленная конфигурация не блокируется старой записью. Сбой между prepare и bindPrompt не разрешает callback неизвестного prompt.

- [ ] **Step 2:** `bun test services/githubbot/tests/store.test.ts` → FAIL.
- [ ] **Step 3: Реализовать Store через bun:sqlite.** Одна БД/WAL, UNIQUE updateId и requestId, synchronous transactions без await внутри. Сохранить минимальный Input, а не все сообщения группы. Cursor подтверждает только уже записанный batch. Заявки без выбранного repo не блокируют последующие команды; outbox хранится в Job output с nextOutput. Выполненные запросы не переигрываются при отправке ответа. TTL 24h проверяется при choose; cleanup просроченных заявок допустим после истечения, журнал неопределённых созданий сохраняется.
- [ ] **Step 4:** команда Step 2 и typecheck → PASS; тест с file reopen обязателен, in-memory SQLite его не заменяет.
- [ ] **Step 5:** `git add services/githubbot && git commit -m "feat: persist bot requests and prevent duplicate issue creation"`.

### Task 5: Выполнение команд и восстановление

**Files:** Create `src/handler.ts`, `tests/handler.test.ts`; modify `tests/fixtures.ts` (типизированные in-memory doubles только для API).

**Interfaces:** Consumes все предыдущие интерфейсы. Produces `Send = (context:Context,message:Outgoing)=>Promise<number>`, `AnswerCallback=(id:string,text:string)=>Promise<void>`, `HandlerDeps {config:Config;store:Store;github:Github;projects:Projects;send:Send;answerCallback:AnswerCallback;now:()=>Date}` и `handleJob(job:Job,deps:HandlerDeps):Promise<void>`.
Handler сначала валидирует actor/chat и stale alias для каждого возобновления, затем работает с сохранённой фазой. `kind:'error'` сохраняет output с подсказкой, не вызывает API GitHub. `phase:'uncertain'` доставляет предупреждение, не повторяет мутацию. `received` команд нормализуется в ready/waiting_repo. Для `choice` отдельный Job подтверждает callback и переводит оригинальный job в ready; повторный callback не повторяет execute original.

- [ ] **Step 1: Написать end-to-end unit tests** с настоящим Store и fake Github/Projects/Send. Для topic 11 создать ровно один backend issue; topic 14 отправляет buttons без вызова Github; чужой выбор вызывает только answerCallback с отказом. Повтор owner callback и restart между create/checkpoint/send дают прежнюю URL, а не новый POST. Callback идёт только для сохранённого promptMessageId.

```ts
expect(createCalls).toEqual([{repo:'backend',title:'Backend. X',body:''}]);
expect(initializedIssues).toHaveLength(1);
expect(sent.at(-1)?.message.html).toContain('/backend/issues/1');
// Отдельный тест: GitHub вернул issue, Projects отказал.
expect(createCalls).toHaveLength(1);
expect(sent.at(-1)?.message.html).toContain('создана');
expect(sent.at(-1)?.message.html).toContain('/backend/issues/1');
```

Добавить все пять мутаций и две сводки: unknown alias не вызывает mutation; известный actor с изменённым username блокирует старый alias, включая повтор после restart; assignme продолжает использовать ID. Actor вне config, анонимный actor, чужая группа → ни вызовов Github, ни утечки сводки. Запрет canAssign объясняется человеку. create uncertain → предупреждение, один POST даже после recover; отправка ответа упала → повторяются только send, не create/close/assign. `tosprint` с внешней сменой статуса сообщает фактическое значение без обратной записи.

- [ ] **Step 2:** `bun test services/githubbot/tests/handler.test.ts` → FAIL.
- [ ] **Step 3: Реализовать handleJob.** Перед create записать creating; известный Issue сохранить как issue_created до Projects. Initial board error — сформировать частичный ответ и не создавать второй issue. Для остальных мутаций сохранить mutating; read-before-write при восстановлении. Перед send сохранить output; после send сохранить messageId/nextOutput. Для prompt вызвать bindPrompt, затем перевести original job в waiting_repo; для финального ответа — done. Незавершённая отправка prompt остаётся reply_pending, не waiting_repo, чтобы повторить только отправку. Не гарантировать отсутствие дубля Telegram-ответа при потере ответа sendMessage: повтор такого уведомления не должен повторять Github-действие. Повторять retryable не больше трёх попыток, сохранять attempts и nextAttemptAt; задержка retryAfterMs либо 5 секунд, затем явная ошибка; uncertain create никогда не повторять. Unknown actor молча игнорируется, авторизованному actor сообщается ошибка аргументов.
- [ ] **Step 4:** `bun test services/githubbot/tests`; `bun run --cwd services/githubbot typecheck` → PASS.
- [ ] **Step 5:** `git add services/githubbot && git commit -m "feat: execute GitHubBot commands with recoverable results"`.

### Task 6: Telegram transport и работающий процесс

**Files:** Create `src/{telegram,main}.ts`, `tests/{telegram,runtime}.test.ts`, `README.md`.

**Interfaces:** Consumes Config, Input, Outgoing, ApiError, Store, handleJob. Produces `createTelegram(config:Config,fetcher:typeof fetch):Telegram`; методы `getMe():Promise<BotIdentity>`, `getWebhookUrl():Promise<string>`, `getUpdates(offset:number,signal:AbortSignal):Promise<unknown[]>`, `send(context:Context,message:Outgoing):Promise<number>`, `answerCallback(id:string,text:string):Promise<void>`. getUpdates строго валидирует верхний уровень каждого update_id; malformed update не подтверждается молча.
Main exports `run(config:Config,fetcher:typeof fetch,signal:AbortSignal):Promise<void>`, `checkHealth(path:string,now:number):boolean`; основной CLI запускается только под `import.meta.main`. Store path/heartbeat получают из Config. Poll timeout 25 секунд, network timeout 35 секунд; остальные запросы 15 секунд.

- [ ] **Step 1: Написать failing tests**: proxy применяется только к api.telegram.org; request body getUpdates содержит offset и allowed_updates message/callback_query; Telegram HTTP200 `{ok:false}` → ApiError, 429 учитывает parameters.retry_after. getMe/getWebhookInfo проверены до получения updates; существующий webhook останавливает процесс без deleteWebhook. Null/нечисловой update_id останавливает batch без offset advance.

```ts
expect(pollBody.allowed_updates).toEqual(['message','callback_query']);
expect(sentBody.message_thread_id).toBe(11);
expect(methodCalls).not.toContain('deleteWebhook');
expect(checkHealth(heartbeatPath, lastSuccess+120001)).toBe(false);
```

Runtime tests: batch с двумя командами и irrelevant message сохраняет оба Input до offset highest+1; malformed command авторизованного пользователя получает durable error reply, а не теряется при crash. Ожидающий repo job не останавливает polling. SIGTERM aborts polling, ждёт текущий ограниченный timeout этап, закрывает SQLite; restart продолжает queued command. Keyboard callback отвечает своевременно (до долгой GitHub-операции). Невалидные токены/403 → процесс не считается здоровым; токены не присутствуют в capture logs.

- [ ] **Step 2:** `bun test services/githubbot/tests/telegram.test.ts services/githubbot/tests/runtime.test.ts` → FAIL.
- [ ] **Step 3: Реализовать transport/main.** Отдельные polling и последовательный worker в одном процессе; SQLite синхронизирует intake. Короткий poll/backoff с AbortSignal, без блокировки на waiting_repo. Для CommandError сохранить Input `kind:'error'` из Task 1; handleJob из Task 5 превращает его в reply_pending без GitHub-вызовов; точно так же phase uncertain только отправляет сохранённое предупреждение; никаких необработанных исключений и plaintext dump update. Актуальные getMe ID/username передать decoder. Не читать секреты через логи. `--check-config` не делает сетевых вызовов; `--health` читает файл. README описывает config и privacy disable, синтаксис, смену alias, uncertain create и доступы PAT.
- [ ] **Step 4:** full service tests + typecheck → PASS. Локальный smoke с fake HTTP и SIGTERM → exit 0, SQLite содержит завершённые job и offset.
- [ ] **Step 5:** `git add services/githubbot && git commit -m "feat: run GitHubBot with Telegram polling and graceful shutdown"`.

### Task 7: Контейнер, CI и передача на интеграционную приёмку

**Files:** Create `services/githubbot/{Dockerfile,Dockerfile.dockerignore}`, `.github/workflows/githubbot-image.yml`, `tests/{githubbot-workflows.test.ts,githubbot-docker.sh}`; Modify `.github/workflows/checks.yml`, `tests/lint.sh`, `README.md`, service README.

**Interfaces:** Consumes CLI/env/image contract выше; produces публичный GHCR digest и reproducible smoke без live токенов. Infra не импортирует TS-код.

- [ ] **Step 1: Написать failing проверки**: docker smoke запускает `--check-config` с валидным/невалидным synthetic config, `--health` со свежим/старым heartbeat, записывает SQLite от bun в volume и читает из нового контейнера. `githubbot-workflows.test.ts` проверяет PR только test/build, publish только trusted push/main, full SHA tag, root Docker context и отказ публикации при test failure.

```ts
expect(imageWorkflow.on.push.branches).toEqual(['main']);
expect(imageWorkflow.permissions.packages).toBe('write');
expect(buildCommand).toContain('-f services/githubbot/Dockerfile');
expect(buildCommand.endsWith(' .')).toBe(true);
```

- [ ] **Step 2:** `bun test tests/githubbot-workflows.test.ts` и `docker build -f services/githubbot/Dockerfile -t githubbot:test .` → FAIL (отсутствующие artifacts).
- [ ] **Step 3: Добавить Docker/CI.** Bun image 1.4.4-alpine, WORKDIR `/app/services/githubbot`, COPY service и единственный sibling format.ts с сохранением относительного пути; USER bun, /data writable, без EXPOSE/secret build args. Не читать .env из build context. Использовать Dockerfile-specific `services/githubbot/Dockerfile.dockerignore` с allowlist service и format.ts. Publisher на push/main сначала выполняет тесты/typecheck и smoke, затем publishes `sha-$GITHUB_SHA`; registry digest проверяется после push. Job проверок `githubbot` в checks.yml работает и на PR. Не рефакторить существующий webhook publisher ради общей обёртки.
- [ ] **Step 4:** `bun test services/githubbot/tests tests/githubbot-workflows.test.ts`; `bun run --cwd services/githubbot typecheck`; `docker build -f services/githubbot/Dockerfile -t githubbot:test .`; `bash tests/githubbot-docker.sh githubbot:test`; `bash tests/lint.sh` → PASS. При изменении shared format дополнительно весь webhook-alerts test/typecheck; по этому плану менять его не требуется.
- [ ] **Step 5: Дописать раздел живой приёмки README.** До готовности image допустим только fake API smoke. После image + infra#111 выполнить в группе все сценарии спеки: три топика и buttons, обе карточки reply, URL, assign/unassign/assignme/close/tosprint, общая/личная сводка, перезапуск. Разрешение на отправку проверочных сообщений/команд человеком должно быть явным; если его нет, подготовить команды и запросить тест у владельца. Не выдавать наблюдение за документацией за живой PASS.
- [ ] **Step 6: Commit:** `git add services/githubbot .github/workflows tests/githubbot* tests/lint.sh README.md && git commit -m "ci: package and verify GitHubBot for auxiliary deployment"`.

## Интеграция и завершение

- [ ] Кодовый PR содержит `Part of Cringe-Driven-Development-Team/.github#60`, поскольку развёртывание и общая приёмка ещё впереди. Не закрывать #60 одним merge кода.
- [ ] После публикации передать infra-плану digest, исходный SHA, результат service CI и инструкцию CLI. Проверить доступность image анонимным pull.
- [ ] Infra PR использует `Closes #111`; закрытие инфраструктурной sub-issue не равно завершению родителя. После общей приёмки закрыть #60 по командному процессу.
- [ ] Реальные chat/topic/user IDs, новые credentials и BotFather-настройка — входные данные развёртывания; сначала искать в доступных конфигурациях и подключённых источниках. Не выводить секреты и не придумывать значения.

## Self-review плана (2026-11-07)

- Покрытие спеки: команды/карточки/префиксы → 1; Issues → 2; Sprint/сводки → 3; перезапуски → 4; права/сценарии → 5; Telegram → 6; CI/образ → 7; прод → infra-план.
- Пять Review Focus привязаны к тестам. Live reply явно оставлен обязательной проверкой, а не объявлен доказанным.
- Исполнитель может выбирать SQL layout и внутренние helper names, но публичные интерфейсы, фазы и JSON env зафиксированы выше.
- Этот документ — план, команды из него при написании не выполнялись. Метод выполнения должен выбрать владелец.
