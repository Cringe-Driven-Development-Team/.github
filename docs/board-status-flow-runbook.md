# Подключение статусов доски

Состояние на 2026-11-04: локальная реализация готова, идёт ревью; в main и настройках
Projects изменений ещё нет. Родитель: [.github#54](https://github.com/Cringe-Driven-Development-Team/.github/issues/54),
sub-issue: [frontend#152](https://github.com/Cringe-Driven-Development-Team/frontend/issues/152).

## Подготовленные изменения

| Репозиторий | Base main | Изменения |
| --- | --- | --- |
| .github | 644eb71 | Обработчик issues.closed, shared job, проверки, правила |
| frontend | 3f780a9 | Board без предварительного Done; общая очередь |
| agent-plugins | 3ee04ec | Caller issues.closed |
| agent-plugins-private | f309c43 | Caller issues.closed |

Проверено: org secret `ADD_TO_PROJECT_PAT` имеет visibility=all; переносить значение
или менять охват не требуется. Три read-only GraphQL query нового обработчика
прошли на реальной frontend#119. Значения карточек этим не менялись.

Локальные проверки: обработчик 33 теста; общий workflow/регрессии 50 тестов;
межрепозиторная интеграция 8 тестов; frontend release 95 тестов, check/test/build;
старый close.sh 22 сценария; actionlint и shellcheck. Интеграционный тест
при намеренно разных группах воспроизводит регрессию после записи Board.
Он не заменяет проверку hosted очереди GitHub.

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

## Восстановление

- Failed issues.closed: повторить конкретный job в Actions. Он перечитает актуальный
  цикл закрытия; повтор не пишет одинаковый Status и не регрессирует поздний выпуск.
- После публикации/выкатки можно повторить Board:

```bash
gh workflow run release-status.yml -R Cringe-Driven-Development-Team/frontend --ref main
```

- Общая группа `release-board`, `queue: max`, `cancel-in-progress: false` сериализует
  frontend writers. GitHub допускает до 100 ожидающих jobs; отменённый сверх лимита
  job требует адресного rerun. Порядок ожидания не гарантирует порядок событий.
- Не включать Item closed как fallback: он снова даст ложный Done после merge.

## Ожидающие проверки

- Независимое ревью, PR и CI на опубликованных ветках.
- Merge и фактическое отключение Item closed.
- Конфигурация остальных встроенных workflows в авторизованном UI.
- Живые переходы и очередь Actions, затем Done при следующей выкатке.
