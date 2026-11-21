# План вывода из эксплуатации отдельной wiki

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель.** Убрать сгенерированную wiki из трёх репозиториев, опубликованной документации и локальной установки.

**Архитектура.** Сначала `docs` публикует VitePress и веточные превью без зависимости от `infra`. После подтверждения Pages удаляются источник, запуск публикации и локальная интеграция.

**Стек.** Bun 1.3.13 в CI документации, VitePress, Docker, GitHub Actions и Pages, Codex MCP и глобальный npm.

**Спецификация.** [Вывод из эксплуатации отдельной wiki](../specs/2026-11-21-retire-generated-wiki-design.md).

## Общие ограничения

- Для каждого PR брать свежий `origin/main` и изолированный worktree в `.worktrees/` его репозитория. Проверять head, mergeability и обязательные проверки перед слиянием.
- Перед началом задать `RETIRED_COMPONENT` точным названием продукта из поручения в нижнем регистре. Проверять имена и текст отслеживаемых файлов. Код 0 означает совпадение, 1 означает пустой результат, любой иной код означает ошибку поиска.
- Основной VitePress-сайт, граф модулей, схемы и превью действующих PR входят в приёмку. `docs#193` и `backend#127` уже закрыты.

## Что особенно проверить

1. Сборка превью использует правильный `SITE_BASE` и не передаёт credentials из окружения.
2. Локальная Docker-сборка в связанном worktree может прочитать Git-метаданные основного репозитория.
3. Открытый `docs#194` сохраняет коммиты и превью, а старые превью не содержат артефактов wiki даже после следующей выкладки.
4. Организационный секрет удаляется после отключения последнего потребителя.
5. Другая установленная интеграция Codex и глобальные npm-пакеты переживают локальную очистку.

---

### Task 1. Убрать wiki из сборки и сайта `docs`

**Файлы.** `package.json`, `bun.lock`, `.gitignore`, `.github/workflows/{ci,pages}.yml`, `scripts/{docker,build-site,noindex,check-readability}.ts` и связанные тесты, `site/.vitepress/config.mts`, `site/index.md`, страницы `site/documentation/`, инструкции `AGENTS.md`, `CLAUDE.md`, `README.md`, обе копии `docs-site/SKILL.md` и затронутые планы/спецификации. Удаляются каталог wiki, файл правил корпуса, отдельный workflow свежести и скрипты, CSS и тесты, принадлежащие только wiki.

**Интерфейсы.** `previewBuildEnv(env, slug): Record<string, string | undefined>`. `dockerRunArgs(tag, repoRoot, script, args, inputs?: { gitCommonDir?: string }): string[]`. `DockerDeps.prepareInputs?(): Promise<{ gitCommonDir?: string }>`. Сборка выпускает обычный `dist`, пригодный для `site --main-built`.

- [ ] **Показать исходный отказ.** Поискать имя через `git grep -Iin -F -e "$RETIRED_COMPONENT" HEAD --`. Ожидается код 0. В `scripts/build-site.test.ts` задать ожидание `previewBuildEnv({PATH:"/bin", GH_TOKEN:"fixture", API_PASSWORD:"fixture"}, "check")` равным `{PATH:"/bin", SITE_BASE:"/branches/check/"}`. Выполнить `bun test scripts/build-site.test.ts`. Изменённый тест ожидаемо падает на старом контракте с третьим аргументом.
- [ ] **Убрать экспорт и сетевую подготовку.** Удалить посвящённые wiki файлы, npm-зависимость и её команды, обновить lockfile через Bun. Из CI и Pages убрать подготовку снимка, Docker mount и браузерные вызовы wiki, сохранив общие typecheck, тесты, сборку и Pages deploy. Удалить параметры снимка из Docker и превью. Сохранить отдельный mount `gitCommonDir` и фильтрацию ключей по `TOKEN|SECRET|PASSWORD|CREDENTIAL`.
- [ ] **Убрать ссылки и проверочные сценарии wiki.** В смешанных тестах сохранить проверки обычной навигации, читабельности и `noindex`. В `docker.test.ts` проверить точную пару `"-v", "/worktrees/repo/.git:/worktrees/repo/.git"` для `gitCommonDir`, существующие аргументы контейнера и вызов `site:native --main-built`. Сверить ссылки между оставшимися файлами.
- [ ] **Проверить и закоммитить.** `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run modules:check`, `bun run build` в связанном worktree и `git diff --check` проходят. В `dist` остаются главная, страницы документации и граф модулей. Поиск по staged дереву пуст. Открыть PR `docs`, дождаться обязательного CI на его head.

### Task 2. Опубликовать Pages и очистить превью

**Интерфейсы.** Потребляет прошедший CI PR Task 1, ветки `docs#193` и `docs#194`, workflow `pages.yml`. Выдаёт успешный финальный Pages run, чистый артефакт и проверенные URL для Task 3.

- [ ] **Убрать ветку закрытого PR.** Через `gh pr view 193 --json state,headRefName,headRefOid` сверить статус `CLOSED` и точный remote head. Удалить этот ref с lease на подтверждённый SHA и проверить отсутствие через `git ls-remote`.
- [ ] **Влить PR `docs`.** Сверить актуальные head, mergeability и CI. Дождаться появления merge SHA в `origin/main`. Если `docs#194` ещё открыт, сохранить его исходный head, вызвать `gh pr update-branch 194 -R Cringe-Driven-Development-Team/docs` и проверить, что новая вершина содержит прежние коммиты и очищенный `main`. Содержательный конфликт разобрать с владельцем.
- [ ] **Проверить финальную публикацию.** Дождаться успешного `Pages` на очищенном main после обновления веток. При необходимости запустить `gh workflow run pages.yml --ref main`. Скачать артефакт `github-pages`. Проверить все пути, включая `branches/`, и все HTML-ссылки на бывшую wiki. На `https://docs.cellestial.ru` проверить главную и `/documentation/` (HTTP 200), бывший путь и его `graph.json` и `manifest.json` (HTTP 404). При открытом `docs#194` проверить HTTP 200 у `/branches/docs-redis-for-bff/` и отсутствие wiki в этом превью. Сохранить ссылку на финальный run.

### Task 3. Удалить источник и публикацию из `infra`

**Файлы.** Каталог wiki и правила корпуса, workflow проверки свежести и `publish-docs-wiki.yml`, выделенные скрипты и тесты, `AGENTS.md`, `README.md`, `SUMMARY.md`.

**Интерфейсы.** Потребляет подтверждение Task 2 и использует организационный Actions-секрет `DOCS_PAGES_TOKEN`.

- [ ] **Зафиксировать исходное состояние.** Поиск фиксированной строки в именах и тексте `infra/main` показывает совпадения. `gh secret list --app actions --org Cringe-Driven-Development-Team` подтверждает наличие секрета. Зафиксировать его потребителей в актуальных workflow всех репозиториев организации.
- [ ] **Очистить `infra` и влить PR.** Удалить перечисленные файлы, блоки инструкций и ссылки. `git diff --check` проходит, поиск по staged дереву пуст. Проверить PR по актуальному head, влить и повторить поиск на `origin/main`.
- [ ] **Удалить секрет и проверить сервис.** Повторить аудит workflow и при нуле потребителей удалить через `gh secret delete DOCS_PAGES_TOKEN --app actions --org Cringe-Driven-Development-Team`. Проверить список секретов повторно. При другом потребителе отдельно согласовать перенос. `https://hooks.cellestial.ru/health` возвращает HTTP 200.

### Task 4. Очистить два документа `.github`

**Файлы.** `docs/superpowers/{plans/2026-11-21-retired-webhook-cleanup.md,specs/2026-11-21-retired-webhook-cleanup-design.md}`.

- [ ] **Обновить документы.** Снять RED исходным поиском по обоим файлам. Удалить цель, работу и критерии прежней задачи, связанные с wiki. Сохранить описание миграции v8, границы активации и проверки рабочей выкладки. Перенести итоговый поиск по актуальным веткам в оставшуюся проверку. `git diff --check` и пустой staged поиск подтверждают GREEN.
- [ ] **Влить PR.** Ветку с новым согласованным дизайном и этим планом обновить от актуального main. Проверить PR по его head, влить и повторить поиск по `origin/main`.

### Task 5. Убрать локальную интеграцию и подтвердить итог

**Интерфейсы.** Codex `~/.codex/config.toml`, скилл `~/.agents/skills/<имя>`, npm-префикс `~/.local/node`, файлы реестра `CDD` в выделенном каталоге инструмента.

- [ ] **Снять исходное состояние.** Сохранить имена остальных MCP-серверов через `codex mcp list --json` и остальных глобальных пакетов через `npm list -g --depth=0 --json`. Проверить путь бинарника и два файла реестра. Хранить только имена и пути.
- [ ] **Удалить установку.** Выполнить `codex mcp remove "$RETIRED_COMPONENT"`. Убрать скилл из каталога обнаружения. Выполнить `~/.local/node/bin/npm uninstall -g --prefix ~/.local/node "$RETIRED_COMPONENT"`. Переместить выявленный реестр и его копию в корзину. Снова выполнить `codex mcp list --json` и проверить скилл, пакет, бинарник и файлы реестра. Удалённые компоненты отсутствуют, имена остальных серверов и пакетов совпадают с исходным списком.
- [ ] **Проверить итог.** Обновить `origin/main` трёх репозиториев. `git grep -Ii -F -e "$RETIRED_COMPONENT" origin/main --` и `git ls-tree -r --name-only origin/main | rg -i -F -- "$RETIRED_COMPONENT"` дают код 1 без совпадений. Повторить публичные HTTP-проверки Task 2 после очистки `infra` и проверить секрет и `/health`. В итоговом отчёте приложить PR и Pages run.
