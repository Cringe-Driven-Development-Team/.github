# Подключение статусов доски

Состояние на 2026-11-04: все четыре PR влиты в main по поручению пользователя. Post-merge CI, публикация
frontend и course-sync успешны. Item closed выключен пользователем и подтверждён через API; живая приёмка продолжается. Родитель: [.github#54](https://github.com/Cringe-Driven-Development-Team/.github/issues/54),
sub-issue: [frontend#152](https://github.com/Cringe-Driven-Development-Team/frontend/issues/152).

## Влитые изменения

| Репозиторий | Base main | Изменения |
| --- | --- | --- |
| [.github PR55](https://github.com/Cringe-Driven-Development-Team/.github/pull/55) | 644eb71 | Обработчик issues.closed, shared job, проверки, правила |
| [frontend PR153](https://github.com/Cringe-Driven-Development-Team/frontend/pull/153) | 3f780a9 | Board без предварительного Done; общая очередь |
| [agent-plugins PR28](https://github.com/Cringe-Driven-Development-Team/agent-plugins/pull/28) | 3ee04ec | Caller issues.closed |
| [agent-plugins-private PR4](https://github.com/Cringe-Driven-Development-Team/agent-plugins-private/pull/4) | f309c43 | Caller issues.closed |

Проверено: org secret `ADD_TO_PROJECT_PAT` имеет visibility=all; переносить значение
или менять охват не требуется. Три read-only GraphQL query нового обработчика
прошли на реальной frontend#119. Значения карточек этим не менялись.

Локальные проверки: обработчик 33 теста; общий workflow/регрессии 50 тестов;
межрепозиторная интеграция 12 тестов; frontend release 95 тестов, check/test/build;
старый close.sh 22 сценария; actionlint и shellcheck. Интеграционный тест
при намеренно разных группах воспроизводит регрессию после записи Board.
Он не заменяет проверку hosted очереди GitHub.

Независимое ревью выявило старое совпадающее значение Status: Board пропускал
запись, и поздний close регрессировал его. Исправление: при подтверждённом выпуске
Board очищает и выставляет тот же Status, затем проверяет updatedAt текущего цикла.
Четыре новые регрессии прошли RED→GREEN, включая сбой между clear/set и повтор.
Это не транзакция: после сбоя Status может остаться пустым; исправлять вручную по Summary.

Read-only API после пользовательского переключения: Item closed №7 enabled=false; остальные проверенные
включённые правила — Auto-close issue, Item reopened, Pull request linked to issue,
Pull request merged. Их конфигурация через API недоступна. Доступный браузер на
странице проекта показывает Sign in, поэтому изменить/проверить настройки может
пользователь в своей авторизованной сессии (после готовности всей замены).

## Проверено после merge

- Frontend #153: `dc03761bb09425f48818a700eab1b60ee06f45a6`, merge queue прошла
  [проверку](https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/41899783386).
- .github #55: `6cbdc68e95e22caaeb12b8b728de5d68d981e0f7`;
  [post-merge Checks](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/41900092751) успешны.
- agent-plugins #28: `2bca06a86e3faf85767611f0ff578ea0f4102555`.
- agent-plugins-private #4: `9c03162b95681d194c5bef252a857d93ca02eec7`.
- [Frontend CI](https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/41900012085):
  Check, Publish release и course-sync / sync успешны. Командный и учебный main
  совпадают: `dc03761bb09425f48818a700eab1b60ee06f45a6`.
- Release-artifacts deployment `7556100974` создан после проверки S3 и GHCR.
- [Board](https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/41900209131)
  выполняется; frontend#152 закрыта мержем. Её первичный Done поставил ещё включённый
  Item closed. Событие issues.closed случилось до мержа общего обработчика,
  поэтому не является проверкой нового перехода Ready for build.

## Исправление, найденное при живой проверке

У frontend#152 GraphQL Issue.closedAt = `2026-11-04T19:45:26Z`, а
ClosedEvent.createdAt = `2026-11-04T19:45:27Z`. Их равенство не гарантируется.
Обработчик сравнивает payload с актуальным Issue.closedAt для идентификации цикла,
а последнее событие timeline должно быть ClosedEvent не старше этого закрытия.
Предыдущее строгое равенство пропускало такое событие. Регрессия воспроизведена
RED→GREEN; старый payload нового цикла по-прежнему пропускается.

Поздний frontend close сохраняет `Ready for release`, `Done` или
`Rollback from production`, если timestamp статуса не старше текущего закрытия.
Более старый статус разрешено заменить на `Ready for build`. Inline-шаги frontend
используют этот же цикл закрытия; их подключение проверяется после merge.

## Порядок подключения

1. После разрешения на merge проверить актуальные heads, required CI и конфликты.
2. Влить frontend Board, общий обработчик и оба plugin callers. Проверить post-merge
   CI frontend и course-sync; рабочие main и учебная копия должны совпасть.
3. В Scrumban → меню проекта → Workflows проверить настройки Item closed,
   Pull request merged, Item reopened, Pull request linked to issue, Auto-close issue.
   Убедиться, что другое правило не выставляет Done связанной issue при мерже.
4. Выключить Item closed №7. Не удалять правило. Проверить enabled=false через
   GraphQL и сохранность остальных нужных правил.
5. Проверить следующие естественные события: прочий repo closed → Done;
   frontend merge → Ready for build; проверенная публикация → Ready for release.
   Записать issue, время, Actions run URL и фактический Status.
6. Done после production проверяется при следующей согласованной выкатке;
   CD ради этой приёмки не запускать автоматически.

Родитель остаётся открытым до подключения. PR .github использует Part of;
frontend PR закрывает свою sub-issue. Результаты живой приёмки пока ожидаются.
Журнал реализации и решений: [execution](superpowers/plans/2026-11-04-board-status-flow-execution.md).

## Обновление карточек внутри CI/CD

Frontend выполняет три перехода по составу одной операции: проверенные S3/GHCR
и успешный Register release → Ready for release; успешные Health check и Production
result CD → Done; успешный Rollback → Rollback from production для удалённых
изменений. Повторная выкатка через CD возвращает эти задачи в Done.
`release report` один раз сохраняет состав в `${{ runner.temp }}/release-report.json`,
а следующий шаг `release board` использует его без полного обхода доски и истории.
Задачи вне диапазона операции не читаются. Публикация сохраняет Done/rollback,
подтверждённые в текущем цикле закрытия; старый цикл не блокирует новую публикацию.

CD допускает только тот же SHA или потомка подтверждённого production; Rollback —
предка или тот же SHA при восстановлении. Проверка Git выполняется до изменения VPS.
Разошедшиеся ветки и неизвестная production-база останавливают операцию. После
A → B → откат на A повторный Rollback, выбравший B, отклоняется без поиска другой
цели; для возврата на B нужен CD.

Publish release, CD, Rollback и frontend issues.closed используют общую группу
`release-board`, `queue: max`, `cancel-in-progress: false`. GitHub допускает до
100 ожидающих jobs; порядок ожидания не гарантирует порядок событий. Check для PR
остаётся независимым. Межрепозиторный integration test запускается локально с
`FRONTEND_DIR=/absolute/frontend/worktree`; CI .github не клонирует frontend и сам
этот тест не выполняет. Проверка моделирует исключение групп, а не hosted очередь.

История Deployments остаётся для `confirmed`, `publicationBase`, `target` и
`retention`, выбора артефактов и доставки Telegram. Полной реконструкции Board нет.

## Восстановление

- Failed issues.closed: повторить конкретный job в Actions. Он перечитает актуальный
  цикл закрытия; повтор не пишет одинаковый Status и сохраняет публикацию/выкатку/откат
  текущего цикла.
- Ошибка карточек после успешной операции делает job красным, но не переписывает
  success Deployment и не запускает откат. Summary отдельно показывает успешную
  операцию, количество изменений и ошибки карточек. Остальные карточки обрабатываются.
  Retention после успешных Health check/Production result выполняется и при ошибке
  карточек; независимый course-sync не мешает завершившемуся Publish release.
- Неполный отчёт даёт ошибку шага карточек без записей Status. Проверить PAT, Scrumban
  №1 и опции Ready for release, Done, Rollback from production. Пропавшие карточки
  или опции автоматически не создаются; сбой clear/set может оставить пустой Status.
- Исправлять карточки вручную по Summary успешной операции. Отдельного workflow
  полного Board и автоматического ремонта больше нет. Повтор той же выкатки с пустой
  разницей не ремонтирует карточки; CI уже опубликованного SHA пропускает их.
- Не включать Item closed как fallback: он снова даст ложный Done после merge.

## Ожидающие проверки

- Конфигурация остальных встроенных workflows в авторизованном UI.
- Живые переходы и очередь Actions, затем Done при следующей выкатке.
