# Перенос разработки 18 октября 2026

Разработка, задачи, PR и ревью обеих областей ведутся в
[team/frontend](https://github.com/Cringe-Driven-Development-Team/frontend) и
[team/backend](https://github.com/Cringe-Driven-Development-Team/backend).
Учебные репозитории получают те же main-коммиты и дерево файлов.
Исторические PR и ревью остаются в исходных репозиториях; новые PR создаются у команды.
Файлы workflows входят в копию, Actions учебных репозиториев выключены настройкой.

## Проверенные результаты

Frontend импортирован через [PR59](https://github.com/Cringe-Driven-Development-Team/frontend/pull/59),
первый migration release — через [PR60](https://github.com/Cringe-Driven-Development-Team/frontend/pull/60).
В обоих случаях blackHATred одобрил фактически слитый head.
[CI39072190814](https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/39072190814)
проверил код, загрузил release и синхронизировал main.
[CD39072242281](https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/39072242281)
успешно выполнил check/promote/health/retention для `48a25b5a2e6f977d5117c74285119a811e82c415`.
Позже команда приняла обычные изменения клиента и успешно выложила `aabca3f95602994f2d7cbd539f42e2e677d32dca`
через [CD39075816938](https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/39075816938);
фактический release meta сайта совпал с этой версией.

Backend импортирован через [PR24](https://github.com/Cringe-Driven-Development-Team/backend/pull/24).
Bootstrap [PR26](https://github.com/Cringe-Driven-Development-Team/backend/pull/26)
создал push CI с задержкой 10 минут 52 секунды. Дополнительный
[PR27](https://github.com/Cringe-Driven-Development-Team/backend/pull/27)
с эквивалентной записью списка branches оказался лишним: старый run появился до его merge.
Причина задержки GitHub не установлена; изменение форматирования не считается её исправлением.

Финальный [PR28](https://github.com/Cringe-Driven-Development-Team/backend/pull/28)
принят обычным merge после Approve blackHATred и зелёных lint/test/docker.
[CI/CD39077257069](https://github.com/Cringe-Driven-Development-Team/backend/actions/runs/39077257069)
успешно опубликовал приватный package, выкатил API и синхронизировал main:

- Commit: `56989f8656b7bf7a71bcfdcc770c00de1d188a18`.
- Image: `ghcr.io/cringe-driven-development-team/backend:sha-56989f8`.
- Digest: `sha256:9a3eab14100c3b09e4873ae1bd2f6d398bda7fdae67ef1ce87b4e9e8eee46c5e`.
- На VPS проверены этот image/digest, container healthy и API JSON с ожидаемым HTTP401.
- Временная авторизация GHCR удалена после pull; старый image сохранён в кеше.
- Backend main SHA и tree `92a02472066a8379e07b2f1e0c170c577e676f01` совпали с учебной копией.

Первая и повторная ручная backend-синхронизация также прошли:
[39076179191](https://github.com/Cringe-Driven-Development-Team/backend/actions/runs/39076179191),
[39076294679](https://github.com/Cringe-Driven-Development-Team/backend/actions/runs/39076294679).
Синхронизация выполняется независимо от production deploy.

## Настройки и сохранность задач

У обеих командных областей `COURSE_SYNC_ENABLED=true`, `PRODUCTION_ENABLED=true`.
Основные ветки требуют актуальные CI checks GitHub Actions и запрещают
force-push/удаление. Frontend требует одно ревью без bypass. По отдельному запросу
владельца backend approval вынесен в ruleset25323341 с исключением только для
`YarikMix` и только через PR; для остальных остаётся одно ревью.
Backend ruleset25320511 без bypass сохраняет обязательные PR, разрешение обсуждений,
strict `lint/test/docker` и integrity. Исходная политика сохранена перед изменением,
read-only приёмка исключения показала RED до настройки и GREEN после.
На [backend PR29](https://github.com/Cringe-Driven-Development-Team/backend/pull/29)
проверен merge от YarikMix с нулём Approve и зелёными required checks:
стандартный merge API создал `48f527ebab8bee5152bfef9ab7557902f3a2c2d8`.
CLI перед API-вызовом остановился на общем Review required; `--admin` не использовался,
CI/integrity rulesets не ослаблялись.
Последующий [CI/CD39078909679](https://github.com/Cringe-Driven-Development-Team/backend/actions/runs/39078909679)
прошёл publish/deploy/sync; backend source/course main равны `48f527ebab8bee5152bfef9ab7557902f3a2c2d8`,
tree — `aed445d86661319a5dac83ba70a283fde91d1a98`.
Repository settings разрешают только merge commit. Production environments допускают только main.
Учебные main защищены отдельными integrity rules без bypass, по одному выделенному write deploy key.
Их старые Actions отключены, новых runs после переключения не появилось.

IDs всех четырёх репозиториев сохранены. Проверки metadata именно в окне импорта
вернули compare0: frontend напрямую, backend после отдельно документированного
учёта задачи25/card, созданных до import merge. Исходные снимки и raw diff сохранены.
Новые frontend-задачи61/63 и позднейшее перемещение backend25 из Backlog в In review
зафиксированы как последующие изменения; исходные issue/relations не изменены,
автор перемещения карточки по использованному API не установлен. Восстановление старого состояния не выполнялось.
Рабочая backend-ветка `api-3` сохранена у команды с исходным SHA и не включена в main автоматически.

Phase-B инструкции приняты в [.github17](https://github.com/Cringe-Driven-Development-Team/.github/pull/17)
и [agent-plugins10](https://github.com/Cringe-Driven-Development-Team/agent-plugins/pull/10).
Monitoring `COURSE_MIGRATED_REPOS=["frontend","backend"]` проверен.
Две frontend-ссылки обновлены через [PR64](https://github.com/Cringe-Driven-Development-Team/frontend/pull/64):
Check прошёл, blackHATred одобрил актуальный head, выполнен обычный merge
`14c84a9b07438747f49af904038581e58630e23e`; push CI39078505464 успешен.
Финальные frontend source/course main равны этому SHA, tree —
`59367c07aee89e5bb15c726e84a9b856866954a9`. Production остаётся на отдельно
проверенном релизе `aabca3f`; docs-only merge не выполняет автоматический promote.

## Восстановление и дальнейшая работа

[Infra53](https://github.com/Cringe-Driven-Development-Team/infra/pull/53) принят после
публикации package и успешного sync. Полный deployment suite11/11 и независимое ревью прошли.
Новый отдельный public CI key установлен с проверкой SSH host key и сохранением старых ключей.
Операторский private key в CI не переносился.

Старый backend `sha-ea43353` сохранён на VPS и в проверенном Docker archive вне checkout:
10,330,624 bytes, SHA256 `7701d04f6fa2c18c270af93067707496aa0088ded2a92e853619ea6cbfbfaa38`.
Проверены OCI blobs/index и загрузка в отдельный Docker. Обычный pull старого package требует
старый read credential; текущим операторским OAuth этот доступ не подтверждён.
Для немедленного восстановления без registry предусмотрен
[проверенный manual override](https://github.com/Cringe-Driven-Development-Team/infra/blob/main/ansible/README.md)
с запретом pull и заменой только API. Архив, старые packages, ключи, volumes и БД не удалялись.

Существующим клонам нужно переключить origin на соответствующий team/frontend или team/backend,
выполнить fetch и проверить `git remote -v` перед push. Новые задачи и `Closes #N` локальны
для своего командного репозитория; межрепозиторные sub-issues сохраняют прежний порядок.
Порядок действий и отката — в [runbook](team-repositories-runbook.md),
решения подготовки — в [preparation journal](preparation-journal.md).

Отложенный Minor: сообщение о сбое sync содержит source/SHA/run URL, но не прямую ссылку
на учебное назначение. Исправление требует нового shared commit и обновления обоих caller pins;
в этом окне изменение автоматики не расширялось.
