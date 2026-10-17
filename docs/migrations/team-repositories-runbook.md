# Перенос разработки в командную организацию

Статус: локальная подготовка. Инструкция описывает будущее окно; удалённые изменения выполняются только после согласования преподавателей. Сначала фронтенд, затем отдельным окном бэкенд.

| Область | PRIMARY: разработка, задачи, PR, Actions | COURSE: копия main |
| --- | --- | --- |
| frontend | Cringe-Driven-Development-Team/frontend | frontend-park-mail-ru/2026_2_Cringe_Driven_Development |
| backend | Cringe-Driven-Development-Team/backend | go-park-mail-ru/2026_2_Cringe_Driven_Development |

В COURSE копируются коммиты и дерево main, включая YAML Actions. Actions отключаются настройкой репозитория. Новые PR, ревью, номера задач и runs не копируются. Старые PR и issues сохраняются на своих местах.

## Допуск к окну

Нужны согласование преподавателей, admin доступ к обеим репозиториям пары (либо участие администратора), доступ к Projects №1, оригиналам секретов и production. Secrets API показывает имена, но не значения. 403, неполный snapshot или неизвестный тип поля Projects останавливают окно.

Общий reusable workflow сначала публикуется из подготовленной ветки .github с сохранением коммита, указанного в callers. Literal SHA в uses и automation_ref должен совпадать с проверенным опубликованным коммитом. После исправления общей автоматики обновить оба callers и повторить проверки; не подставлять main.

Проверить доступность reusable workflow и Actions policy. PRIMARY/main должна требовать PR, одно одобрение ментора и разрешённые обсуждения, запрещать force push и удаление. Required checks включаются по фактически появившимся именам: frontend — Check; backend — lint, test, docker. Deploy и sync не являются checks исходного PR.

Примеры выполняются в Bash (Linux/WSL). Backup и журнал хранятся вне Git: они содержат приватные метаданные и значения vars. SHA и даты получают заново в каждом окне.

~~~bash
set -euo pipefail
AREA=frontend                    # во втором окне: backend
PRIMARY="Cringe-Driven-Development-Team/$AREA"
if [ "$AREA" = frontend ]; then
  COURSE=frontend-park-mail-ru/2026_2_Cringe_Driven_Development
else
  COURSE=go-park-mail-ru/2026_2_Cringe_Driven_Development
fi
AUTOMATION=/mnt/f/Github/cringe-driven-development-team/.github
PREP_REPO="/mnt/f/Github/cringe-driven-development-team/migration-prep/$AREA"
BACKUP_ROOT="/mnt/f/Github/migration-artifacts/$(date -u +%Y%m%dT%H%M%SZ)/$AREA"
umask 077
mkdir -p "$BACKUP_ROOT"
~~~

Заморозить merge, редактирование задач/карточек и ручные production jobs этой пары. Зафиксировать владельца окна; сообщения команде отправляются отдельно, инструменты подготовки их не отправляют.

~~~bash
for REPO in "$PRIMARY" "$COURSE"; do
  NAME=$(printf '%s' "$REPO" | cut -d/ -f1)
  gh api --paginate --slurp "repos/$REPO/branches?per_page=100" > "$BACKUP_ROOT/$NAME-branches.json"
  gh pr list -R "$REPO" --state open --limit 1000 --json number,title,url,headRefName,baseRefName > "$BACKUP_ROOT/$NAME-open-prs.json"
  gh api --paginate --slurp "repos/$REPO/actions/runs?per_page=100" > "$BACKUP_ROOT/$NAME-runs.json"
  jq '[.[] | .workflow_runs[] | select(.status != "completed")]' "$BACKUP_ROOT/$NAME-runs.json"
  gh api "repos/$REPO/actions/permissions" > "$BACKUP_ROOT/$NAME-actions.json"
done
bash "$AUTOMATION/scripts/migration-state.sh" snapshot "$PRIMARY" "$COURSE" "$BACKUP_ROOT/before"
git clone --mirror "https://github.com/$PRIMARY.git" "$BACKUP_ROOT/primary.git"
git clone --mirror "https://github.com/$COURSE.git" "$BACKUP_ROOT/course.git"
git -C "$BACKUP_ROOT/primary.git" bundle create "$BACKUP_ROOT/primary.bundle" --all
git -C "$BACKUP_ROOT/course.git" bundle create "$BACKUP_ROOT/course.bundle" --all
git -C "$BACKUP_ROOT/primary.git" bundle verify "$BACKUP_ROOT/primary.bundle"
git -C "$BACKUP_ROOT/course.git" bundle verify "$BACKUP_ROOT/course.bundle"
test "$(git -C "$BACKUP_ROOT/primary.git" rev-parse refs/heads/main)" = "$(jq -r .primary_sha "$BACKUP_ROOT/before/manifest.json")"
test "$(git -C "$BACKUP_ROOT/course.git" rev-parse refs/heads/main)" = "$(jq -r .course_sha "$BACKUP_ROOT/before/manifest.json")"
test "$(git ls-remote "https://github.com/$PRIMARY.git" refs/heads/main | cut -f1)" = "$(jq -r .primary_sha "$BACKUP_ROOT/before/manifest.json")"
test "$(git ls-remote "https://github.com/$COURSE.git" refs/heads/main | cut -f1)" = "$(jq -r .course_sha "$BACKUP_ROOT/before/manifest.json")"
~~~

Открытые рабочие PR сначала завершить или согласованно перенести. Активных writers/runs не должно остаться. Не отменять чужие jobs автоматически. Если main изменился между snapshot и backup, начать снимок заново.

До публикации ветки импорта составить отчёт по сообщениям коммитов, которые
впервые появятся в PRIMARY/main. Инструмент читает только локальную Git-историю
и проверенный snapshot; refs и метаданные не меняет, существующий отчёт не затирает.

~~~bash
bash "$AUTOMATION/scripts/migration-closing-refs.sh" \
  "$BACKUP_ROOT/course.git" "$BACKUP_ROOT/primary.git" \
  "$BACKUP_ROOT/before" "$BACKUP_ROOT/historical-closing-references.json"
jq -r '.candidates[] | .sha as $sha | .references[] |
  [$sha, .text, .repository, .number, (.primary_issue.id // ""),
   (.primary_issue.state // ""), (.primary_issue.title // "")] | @tsv' \
  "$BACKUP_ROOT/historical-closing-references.json" \
  > "$BACKUP_ROOT/historical-closing-references.tsv"
~~~

JSON сохраняет полный message и SHA каждого кандидата, найденные короткие,
квалифицированные и URL-ссылки, а также ID/title/state совпавшей задачи PRIMARY.
Уже имеющиеся в PRIMARY коммиты исключаются; SHA обеих main должны совпадать
со свежим snapshot. Это консервативный список кандидатов: все ссылки в сообщении
с closing keyword требуют ручного разбора, он не имитирует весь парсер GitHub.
Проверить отчёт вместе с ментором до push/merge импорта и записать проверявшего,
найденные совпадения и решение в журнал окна. Непонятное или неприемлемое
совпадение останавливает окно; исторические сообщения не переписываются.
Выключенные Actions приостанавливают Telegram-автоматику, но не встроенные
закрытия/уведомления GitHub. Последующая сверка восстановит состояние, однако
не уберёт timeline events и уже отправленные GitHub notifications.
Этот preflight не заменяет snapshot/compare после импорта.

## Отключение writers и доступ

Только после допуска к окну:

~~~bash
printf '{"enabled":false}\n' > "$BACKUP_ROOT/actions-off.json"
gh api -X PUT "repos/$PRIMARY/actions/permissions" --input "$BACKUP_ROOT/actions-off.json"
gh api -X PUT "repos/$COURSE/actions/permissions" --input "$BACKUP_ROOT/actions-off.json"
gh variable set PRODUCTION_ENABLED -R "$PRIMARY" --body false
gh variable set COURSE_SYNC_ENABLED -R "$PRIMARY" --body false
~~~

Отключение Actions не останавливает уже работающий процесс. Дождаться завершения активных production jobs; старый runtime продолжает обслуживать пользователей.

В COURSE текущие ограничения реализованы rulesets. Исходные подробности сохранены в settings-course.json; не заменять их вслепую classic protection. Для прямого push deploy key:
1. Settings → Rules → Rulesets: сохранить force-push/deletion запреты в отдельном активном ruleset без исключения для sync key.
2. Требование PR выделить в отдельный ruleset, дать bypass только Deploy Key этой пары через actor Deploy keys. Если UI разрешает всем deploy keys, оставить в COURSE единственный write key для sync.
3. Не добавлять общий admin bypass. Проверить effective rules для обычного человека, force push и удаления, без разрушительных проб на main.
4. Записать изменённые и созданные rule IDs для восстановления. Если нужный bypass недоступен, остановиться и согласовать доступ с администратором.

Уникальный ключ создаётся только в окне и отдельно для каждой пары. Private key не входит в Git или backup:

~~~bash
KEY_DIR=$(mktemp -d)
ssh-keygen -q -t ed25519 -N '' -C "course-sync-$AREA" -f "$KEY_DIR/id_ed25519"
gh repo deploy-key add "$KEY_DIR/id_ed25519.pub" -R "$COURSE" --allow-write --title "course-sync-$AREA"
gh secret set COURSE_SYNC_SSH_KEY -R "$PRIMARY" < "$KEY_DIR/id_ed25519"
rm -- "$KEY_DIR/id_ed25519" "$KEY_DIR/id_ed25519.pub"
rmdir -- "$KEY_DIR"
~~~

При ошибке удалить локальные файлы вручную; ID созданного deploy key записать в журнал. Ключ не используется другой парой. GitHub host key закреплён в workflow: при ротации сверять официальный источник, не доверять результату ssh-keyscan без проверки.

В PRIMARY восстановить production environment, reviewers и branch policies из исходной конфигурации, разрешить только main. Значения внести из оригинального хранилища через stdin gh secret set:
- frontend: production S3 credentials; endpoint/bucket/CDN vars; TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID/TELEGRAM_TOPIC_ID;
- backend: APIDOG_TOKEN для contract-drift; production SSH/Vault credentials и vars; Telegram. Publishing использует выданный Actions GITHUB_TOKEN;
- COURSE_SYNC_SSH_KEY — repository secret этой пары.

Сверить полный inventory repository/environment/org secret names и vars с YAML всех workflows. Проверить наследование org secrets выбранным PRIMARY. Не унифицировать topics разных областей. До acceptance оба flags false.

## Свежий импорт и review

В локальной подготовке migration/import-base указывает на raw двухродительский merge, migration/import — на конфигурацию поверх него. Сохранить только конфигурационные patches и пересобрать merge из свежих bundles:

~~~bash
git -C "$PREP_REPO" format-patch --stdout migration/import-base..migration/import > "$BACKUP_ROOT/prepared-config.mbox"
bash "$AUTOMATION/scripts/prepare-course-import.sh" \
  "$BACKUP_ROOT/course.bundle" "$BACKUP_ROOT/primary.bundle" "$BACKUP_ROOT/checkout"
git -C "$BACKUP_ROOT/checkout" am "$BACKUP_ROOT/prepared-config.mbox"
git -C "$BACKUP_ROOT/checkout" remote set-url origin "https://github.com/$PRIMARY.git"
git -C "$BACKUP_ROOT/checkout" log --graph --oneline -8
~~~

Конфликты разрешить с владельцем и повторить тесты, не возвращаться к устаревшим SHA. Первый родитель import — PRIMARY/main, второй — COURSE/main; raw import tree равен COURSE/main. Авторы и исходные SHA сохраняются.

Выполнить frontend frozen install/check/build либо backend tidy/build/test/lint/Docker build; actionlint, guards, буквальные SHA и поиск старых активных repo/image URLs. Backup не добавлять в PR.

~~~bash
cat > "$BACKUP_ROOT/pr-body.md" <<'BODY'
Перенос разработки с сохранением обеих историй двухродительским merge.
Код из преподавательского main; CI/CD подготовлены для командного репозитория.
Production и sync пока выключены переменными.
Проверки: заполнить фактическими командами, результатами и SHA.
BODY
git -C "$BACKUP_ROOT/checkout" push origin migration/import
gh pr create -R "$PRIMARY" --base main --head migration/import \
  --title "Перенос разработки в командный репозиторий" --body-file "$BACKUP_ROOT/pr-body.md"
~~~

Обычный review ментора и merge commit; не squash/rebase/--admin. Тело миграционного PR не содержит closing keywords. Исторические коммиты всё равно могут закрыть задачу с совпавшим номером, поэтому Actions пока выключены, обычную работу ещё не открывать.

## Сверка и восстановление метаданных

~~~bash
bash "$AUTOMATION/scripts/migration-state.sh" snapshot "$PRIMARY" "$COURSE" "$BACKUP_ROOT/after-import"
set +e
bash "$AUTOMATION/scripts/migration-state.sh" compare "$BACKUP_ROOT/before" "$BACKUP_ROOT/after-import" > "$BACKUP_ROOT/import-diff.json"
DIFF_STATUS=$?
set -e
test "$DIFF_STATUS" -le 1
jq . "$BACKUP_ROOT/import-diff.json"
~~~

0 — метаданные совпали; 1 — различия; 2 — snapshot неполный/невалидный, продолжение запрещено. Settings сравнивать отдельно: их изменение ожидаемо. Снимок содержит issue state/state_reason/title/body/assignees/labels, parent/sub-issues и карточки включая archived со всеми изменяемыми fields. PR исключены.

Случайно закрытая issue восстанавливается после проверки её номера в diff:

~~~bash
ISSUE_NUMBER=12                   # фактический проверенный номер
jq --argjson n "$ISSUE_NUMBER" '.issues[] | select(.number==$n) | {state,state_reason}' \
  "$BACKUP_ROOT/before/state.json" > "$BACKUP_ROOT/restore-issue.json"
test "$(jq -s length "$BACKUP_ROOT/restore-issue.json")" = 1
gh api -X PATCH "repos/$PRIMARY/issues/$ISSUE_NUMBER" --input "$BACKUP_ROOT/restore-issue.json"
~~~

Для каждой изменённой пары item/field взять исходные IDs и value из snapshot. Следующий блок готовит и выполняет ровно одно проверенное восстановление:

~~~bash
PROJECT_ID=$(jq -r .project_id "$BACKUP_ROOT/before/manifest.json")
ITEM_ID='ID из project.items[].id'
FIELD_ID='ID из project.items[].fields[].id'
jq --arg item "$ITEM_ID" --arg field "$FIELD_ID" \
  '.project.items[] | select(.id==$item) | .fields[] | select(.id==$field)' \
  "$BACKUP_ROOT/before/state.json" > "$BACKUP_ROOT/restore-field.json"
test "$(jq -s length "$BACKUP_ROOT/restore-field.json")" = 1
if jq -e '.value == null' "$BACKUP_ROOT/restore-field.json" >/dev/null; then
  jq -n --arg p "$PROJECT_ID" --arg i "$ITEM_ID" --arg f "$FIELD_ID" \
    '{query:"mutation($p:ID!,$i:ID!,$f:ID!){clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){projectV2Item{id}}}",variables:{p:$p,i:$i,f:$f}}' \
    > "$BACKUP_ROOT/restore-field-request.json"
else
  jq -n --arg p "$PROJECT_ID" --arg i "$ITEM_ID" --arg f "$FIELD_ID" \
    --slurpfile saved "$BACKUP_ROOT/restore-field.json" \
    '($saved[0]) as $s | ({"SINGLE_SELECT":"singleSelectOptionId","ITERATION":"iterationId","TEXT":"text","NUMBER":"number","DATE":"date"}[$s.type]) as $key |
    if $key==null then error("Unsupported field type") else
    {query:"mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){projectV2Item{id}}}",
     variables:{p:$p,i:$i,f:$f,v:{($key):$s.value}}} end' \
    > "$BACKUP_ROOT/restore-field-request.json"
fi
gh api graphql --input "$BACKUP_ROOT/restore-field-request.json" > "$BACKUP_ROOT/restore-field-response.json"
jq -e '(.errors // [] | length)==0' "$BACKUP_ROOT/restore-field-response.json"
~~~

Только null означает отсутствие: zero и пустая строка сохраняются как значения. Archived status восстанавливается archiveProjectV2Item/unarchiveProjectV2Item по исходному item ID после проверки причины.

Body/assignees/labels/relations, добавленные/исчезнувшие карточки массово не перезаписывать: оператор разбирает нарушение заморозки по diff. Удалённая карточка теряет прежний ID — остановить acceptance и разобрать инцидент.

После исправлений сделать новый snapshot в новом каталоге; compare с before должен вернуть 0 до обычной работы. Если затем сервер запрещает sync, production flags остаются false, старый runtime доступен; исправить rules/access с администратором. Не обходить metadata gate.

## CI и первая синхронизация

Включить Actions только в PRIMARY, сохраняя исходную allowed-actions policy:

~~~bash
printf '{"enabled":true}\n' > "$BACKUP_ROOT/actions-on.json"
gh api -X PUT "repos/$PRIMARY/actions/permissions" --input "$BACKUP_ROOT/actions-on.json"
~~~

События при выключенных Actions не воспроизводятся. Сделать обычный содержательный PR с итоговой инструкцией, пройти CI, включить required checks по фактическим именам, получить review и normal merge. Новый push/main создаёт CI run. Rerun ранее skipped jobs не является bootstrap.

После успешных code checks (backend также docker) включить только sync:

~~~bash
gh variable set COURSE_SYNC_ENABLED -R "$PRIMARY" --body true
CI_RUN_ID='ID успешного push/main CI'
gh workflow run sync-to-course.yml -R "$PRIMARY" --ref main -f "ci_run_id=$CI_RUN_ID"
~~~

SHA берётся из CI run, reusable workflow заново проверяет provenance и обязательные jobs. Произвольные ref/SHA/target не задаются. Повторить manual workflow: идемпотентный sync не запускает deploy.

~~~bash
git -C "$BACKUP_ROOT/checkout" fetch origin main
git -C "$BACKUP_ROOT/checkout" fetch "https://github.com/$COURSE.git" main
test "$(git -C "$BACKUP_ROOT/checkout" rev-parse origin/main)" = "$(git -C "$BACKUP_ROOT/checkout" rev-parse FETCH_HEAD)"
test "$(git -C "$BACKUP_ROOT/checkout" rev-parse 'origin/main^{tree}')" = "$(git -C "$BACKUP_ROOT/checkout" rev-parse 'FETCH_HEAD^{tree}')"
gh api "repos/$COURSE/actions/permissions" --jq .enabled  # false
~~~

Проверить отсутствие новых runs в COURSE и Telegram topic. Не создавать production outage ради проверки уведомления: локальные tests покрывают отказ push и cleanup.

## Production и завершение

Frontend: старый writer выключен. Включить PRODUCTION_ENABLED; принять обычный reviewed PR с итогами окна → новый push/main CI загружает release. Существующим ручным CD promote выбранный SHA, проверить health URL из конфигурации, stable и active version. Сохранить предыдущий stable для rollback.

Backend: package ghcr.io/cringe-driven-development-team/backend приватный. Проверить публикацию sha-<short>/main, OCI source label/связь с PRIMARY, write-доступ GITHUB_TOKEN и pull сервера. Старый school package/tag/credential сохраняются; новый token не обязан читать старый приватный package.

Старый deploy читает infra@main: новый image default в infra нельзя мержить заранее. После публикации нового package и остановки старых writers принять подготовленный infra PR, проверить inventory overrides. Затем включить backend PRODUCTION_ENABLED и принять итоговый reviewed PR: новый main CI публикует образ и запускает deploy. Проверить health URL из inventory, container image/tag и отсутствие второго writer. Не пытаться bootstrap через rerun skipped deploy или CD с выключенным flag.

~~~bash
gh variable set PRODUCTION_ENABLED -R "$PRIMARY" --body true
~~~

Выполнить эту команду именно на указанном этапе. Sync и deploy независимы: повтор sync не перезапускает deploy. Сохранить URLs jobs, SHA/tree, compare exit 0, health evidence, reviewers и rollback reference.

Monitoring .github variable COURSE_MIGRATED_REPOS: [] до переноса, ["frontend"] после frontend acceptance, ["frontend","backend"] после backend acceptance. Опубликовать соответствующую фазу документации .github и agent-plugins. Для принятой области мониторятся team CI и manual-sync, course исключается. Остальные репозитории не менять.

Подготовленные локальные doc ветки в обоих репозиториях: docs/migration-phase-a
(только frontend) и docs/migration-phase-b (следующий commit, также backend).
Сначала публикуется backward-compatible monitoring при пустой phase; doc-A
публикуется только после frontend acceptance, doc-B — после backend acceptance.
При публикации doc-B обновить ссылку на backend в frontend README/CLAUDE на
Cringe-Driven-Development-Team/backend; в фазе A там ещё может быть учебная ссылка.
Точные подготовительные SHA и проверки фиксируются в preparation journal;
рабочие SHA/import всё равно пересобираются в каждом окне.

## Откат

Сначала выключить COURSE_SYNC_ENABLED/PRODUCTION_ENABLED, Actions и все новые writers; дождаться jobs. Сделать актуальные snapshot/bundles.

До обычной работы вернуть сохранённое COURSE-дерево новым reviewed commit с сохранением историй. Не применять вслепую git revert -m 1: первый родитель импорта — tasks-stub. Не reset/force-push и не возвращать PRIMARY к заглушке.

После рабочих merge сохранить всю принятую историю и перенести её fast-forward в COURSE. Вернуть workflows отдельным reviewed commit; настройки восстановить с учётом новых коммитов. Старые Actions включать только после нужного дерева/settings и остановки новых writers. При чужой записи в COURSE и невозможном FF остановиться, разобрать историю без затирания.

Frontend runtime: существующий stable rollback с сохранённым release/SHA. Backend: явный старый path ghcr.io/go-park-mail-ru/2026_2_cringe_driven_development и сохранённый sha-tag; повторный pull требует проверенный credential старой организации. Если registry недоступен, использовать сохранённый проверенный image/archive и manual override с `pull_policy: never` по [инструкции infra](https://github.com/Cringe-Driven-Development-Team/infra/blob/main/ansible/README.md). Перед восстановлением выключить production flag и дождаться активных deploy; проверить Compose diff, менять только API. Volumes, БД и миграции данных не менять.

Исходный task snapshot используется только для побочных эффектов импорта в замороженном окне. После начала новой работы не восстанавливать всё старое состояние: исправлять лишь доказанный ошибочный diff относительно актуального baseline.

Окно закрывается после совпадения main SHA/tree, review/CI/sync/health gates, metadata compare, выключения старых writers и публикации нужной фазы инструкций. Старые PR, packages, rollback credentials и backups этим планом не удаляются.

