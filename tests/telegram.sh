#!/usr/bin/env bash
# Прогоняет скрипт из .github/workflows/telegram.yml на подставных событиях.
# Нужны bash, jq, perl, GNU date и awk. Запуск: bash tests/telegram.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/tests/lib.sh"

SCRIPT="$TMP/script.sh"
awk -f "$ROOT/tests/extract-run.awk" "$ROOT/.github/workflows/telegram.yml" > "$SCRIPT"
[ -s "$SCRIPT" ] || { echo "в telegram.yml не найден блок run: |"; exit 1; }

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# заглушка gh api: берёт ответ из env и применяет к нему --jq, как настоящий gh
path=$2
filter="."
while [ $# -gt 0 ]; do
  [ "$1" = "--jq" ] && filter=$2
  shift
done
case "$path" in
  # сравнение без SHA — ошибка в скрипте, а не ответ GitHub
  */compare/*"..."|*/compare/*"...?"*) echo "gh: в сравнении нет SHA: $path" >&2; exit 1 ;;
  */reviews)   body=${GH_REVIEWS-}; fail=${GH_REVIEWS_FAIL-} ;;
  # сравнение со старой версией ветки (force-push) — отдельный ответ
  */compare/*"...${BEFORE:-none}"*) body=${GH_COMPARE_BEFORE-}; fail=${GH_COMPARE_BEFORE_FAIL-} ;;
  */compare/*) body=${GH_COMPARE-}; fail=${GH_COMPARE_FAIL-} ;;
  */comments)  body=${GH_COMMENTS-}; fail=${GH_COMMENTS_FAIL-} ;;
  *) echo "неожиданный запрос $path" >&2; exit 1 ;;
esac
[ -z "$fail" ] || { echo "$fail" >&2; exit 1; }
printf '%s' "$body" | jq -r "$filter"
STUB
chmod +x "$TMP/bin/gh"

# так GitHub заполняет env: отсутствующее поле события — пустая строка, toJSON(null) — null.
# ID в карте и топиках ненастоящие: репозиторий публичный.
DEFAULTS=(
  TOKEN=test-token CHAT=-100 TOPIC=26 REVIEW_TOPIC=77 MAP='{"YarikMix":"111","blackHATred":"222"}'
  EVENT= ACTION= MERGED= DRAFT= BASE= REVIEW= REVIEWER= PR_AUTHOR=
  ACTOR=YarikMix REPO=Cringe-Driven-Development-Team/react
  NUMBER= TITLE= URL= BRANCH= COMMITS=null COMPARE= FORCED=
  BODY= ASSIGNEES=null CREATED= UPDATED= CHG_BODY=null
  REVIEWERS=null PR_CREATED= HEAD_SHA= GH_TOKEN=test-gh
  GH_REVIEWS='[]' GH_REVIEWS_FAIL= GH_COMPARE= GH_COMPARE_FAIL=
  REVIEW_BY= REVIEW_BY_TYPE=User REVIEW_URL= REVIEW_WAIT=0 GH_COMMENTS='[]' GH_COMMENTS_FAIL=
  DELETED=false BEFORE= AFTER= DEFAULT_BRANCH=main GH_COMPARE_BEFORE= GH_COMPARE_BEFORE_FAIL=
)

# когда создан PR: ревьювер из формы создания приходит отдельным событием сразу после opened
LONG_AGO=$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ)
JUST_NOW=$(date -u -d '-5 seconds' +%Y-%m-%dT%H:%M:%SZ)

# --- задачи

when "issue opened: заголовок, автор, исполнитель, описание" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE='Починить <b>вход</b>' URL=https://github.com/o/r/issues/5 \
  ASSIGNEES='[{"login":"blackHATred"}]' BODY=$'## Что сделать\r\nПроверить <!-- скрыто --> & записать' \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T10:00:00Z
sent "🆕 Новая задача" "#5 Починить &lt;b&gt;вход&lt;/b&gt;" \
  'автор: <a href="tg://user?id=111">YarikMix</a>' \
  'исполнитель: <a href="tg://user?id=222">blackHATred</a>' \
  "<blockquote expandable><b>Что сделать</b>" "&amp; записать" "!скрыто"

when "issue closed: без описания" \
  EVENT=issues ACTION=closed NUMBER=5 TITLE=Задача URL=u BODY=текст ASSIGNEES='[]' \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T12:00:00Z
sent "✅ Задача закрыта" "!blockquote"

when "issue edited: правка заголовка молчит" \
  EVENT=issues ACTION=edited NUMBER=5 TITLE=Задача URL=u CHG_BODY=null \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T12:00:00Z
silent

when "issue edited: правка описания в первые 10 минут молчит" \
  EVENT=issues ACTION=edited NUMBER=5 TITLE=Задача URL=u BODY=новое CHG_BODY='{"from":"старое"}' \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T10:05:00Z
silent

when "issue edited: поздняя правка описания" \
  EVENT=issues ACTION=edited NUMBER=5 TITLE=Задача URL=u BODY=новое CHG_BODY='{"from":"старое"}' \
  ASSIGNEES='[]' CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T11:00:00Z
sent "✏️ Описание изменено" "новое"

# --- описание: разметка

when "описание: markdown — разметкой Telegram, HTML-теги сняты, код не тронут" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' \
  BODY=$'**Зачем**\n\nСтейт `pulumi/<id>` и <b>тег</b>, a < b\n- [ ] Создан\n- [x] Готово\n- пункт\n~~старое~~ snake_case __init__\n[док](https://x.io/a?b=1&c=2)\n```bash\necho <x> **нет**\n```'
sent "<blockquote expandable><b>Зачем</b>" "<code>pulumi/&lt;id&gt;</code>" "и тег, a &lt; b" \
  "☐ Создан" "☑ Готово" "• пункт" "<s>старое</s>" "snake_case __init__" \
  '<a href="https://x.io/a?b=1&amp;c=2">док</a>' "<pre>echo &lt;x&gt; **нет**</pre>" "!**Зачем**" "!<b>тег"

when "описание: картинки — ссылками, блочные теги — переводом строки" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' \
  BODY=$'<img width="3192" alt="Image" src="https://github.com/user-attachments/assets/9bee" />\n![скрин](https://i.io/p.png "t")\n<details><summary>Ещё</summary>внутри</details>'
sent '<a href="https://github.com/user-attachments/assets/9bee">🖼 картинка</a>' \
  '<a href="https://i.io/p.png">🖼 картинка</a>' $'Ещё\nвнутри' "!<img" "!width=" "!<details"

when "описание: комментарий HTML внутри кода не вырезается" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' \
  BODY=$'текст <!-- скрыто -->\n```html\n<!-- keep -->\ncode\n```'
sent "<pre>&lt;!-- keep --&gt;" "!скрыто"

LONG=$(printf 'сущ%.0s' $(seq 1 300))
when "описание длиннее 700 символов — многоточие без мусора" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' BODY="$LONG"
sent "…</blockquote>" "!â"

when "описание: блок кода, обрезанный на середине, — без <pre>" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' BODY=$'```go\n'"$LONG"
sent "<blockquote expandable>сущ" "!<pre>" '!```'

when "описание из одного комментария HTML — без цитаты" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' BODY=$'<!-- шаблон -->\n  '
sent "🆕 Новая задача" "!blockquote"

when "Telegram не разобрал разметку цитаты — отправлено без неё" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' BODY='**жирный**' TG_REJECT='<blockquote'
sent "🆕 Новая задача" "!blockquote" "!жирный"
only 1
if grep -qF "::warning::Telegram не разобрал разметку" "$TMP/out"; then pass; else fail "нет ::warning::"; fi

when "Telegram отклонил сообщение без цитаты — job падает" \
  EVENT=issues ACTION=closed NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' TG_REJECT='закрыта'
error "Telegram отклонил сообщение"

when "описание: ссылка не на http(s) не становится кликабельной" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u ASSIGNEES='[]' BODY='[жми](javascript:alert(1)) и [сайт](https://x.io)'
sent '[жми](javascript:alert(1))' '<a href="https://x.io">сайт</a>' '!href="javascript'

# --- пуши

when "push: коммиты ветки" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=https://github.com/o/r/compare/a...b FORCED=false \
  REPO=frontend-park-mail-ru/2026_2_Cringe_Driven_Development \
  COMMITS='[{"id":"aaaaaaa1111","message":"feat: первое\n\nтело","distinct":true},{"id":"ccccccc3333","message":"fix: второе","distinct":true}]'
sent "⚒️ 2 коммита" "· frontend ·" "• aaaaaaa feat: первое" "• ccccccc fix: второе" "!тело"

when "push: без коммитов (создание ветки) молчит" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=false COMMITS='[]'
silent

# --- force-push

# cmp <sha>:<заголовок>… — ответ GET /compare: коммиты ветки поверх main
cmp() {
  printf '%s\n' "$@" | jq -Rsc '{commits: [split("\n")[] | select(length > 0)
    | capture("^(?<sha>[^:]+):(?<m>.*)$") | {sha, commit: {message: .m}}]}'
}
INFRA=Cringe-Driven-Development-Team/infra
# в событии — то, что GitHub кладёт в payload force-push: переписанная ветка вместе с коммитом из main
FP=(EVENT=push BRANCH=refs/heads/task-infra-1 FORCED=true REPO="$INFRA" ACTOR=iRedTea
    COMPARE=https://github.com/o/r/compare/old111...new222 BEFORE=old111 AFTER=new222
    COMMITS='[{"id":"0000000aaaa","message":"Merge pull request #2 from main","distinct":true}]')

when "force-push после rebase: считаем ветку, перечисляем только новые" "${FP[@]}" \
  GH_COMPARE="$(cmp 'aaaaaaa1:chore: начало' 'bbbbbbb2:feat: VPS' 'ccccccc3:fix: замечания ревью')" \
  GH_COMPARE_BEFORE="$(cmp 'ddddddd4:chore: начало' 'eeeeeee5:feat: VPS')"
sent_to 1 26 "<b>⚠️ force-push</b> · infra · " "ветка переписана: 3 коммита поверх main, новых — 1" \
  "• ccccccc fix: замечания ревью" "!aaaaaaa" "!Merge pull request" \
  "\"text\":\"Ветка целиком\",\"url\":\"https://github.com/$INFRA/compare/main...task-infra-1\""
before "ветка переписана" "• ccccccc"
only 1

when "чистый rebase — «новых коммитов нет», без списка" "${FP[@]}" \
  GH_COMPARE="$(cmp 'aaaaaaa1:chore: начало' 'bbbbbbb2:feat: VPS')" \
  GH_COMPARE_BEFORE="$(cmp 'ddddddd4:chore: начало' 'eeeeeee5:feat: VPS')"
sent "ветка переписана: 2 коммита поверх main, новых коммитов нет" "!• "

when "ветка сброшена до main" "${FP[@]}" GH_COMPARE='{"commits":[]}'
sent "<b>⚠️ force-push</b>" "ветка сброшена до main" "!• " "Ветка целиком"

when "старой версии ветки нет — перечисляем всю ветку" "${FP[@]}" \
  GH_COMPARE="$(cmp 'aaaaaaa1:chore: начало' 'bbbbbbb2:feat: VPS')" GH_COMPARE_BEFORE_FAIL="HTTP 404: Not Found"
sent "ветка переписана: 2 коммита поверх main" "!новых" "• aaaaaaa chore: начало" "• bbbbbbb feat: VPS"

when "у ветки нет общей истории с main — коммиты из события" "${FP[@]}" \
  GH_COMPARE_FAIL="gh: No common ancestor between main and new222. (HTTP 404)"
sent "<b>⚠️ force-push</b>" "у ветки нет общей истории с main" "• 0000000 Merge pull request #2 from main" \
  '"text":"Открыть изменения","url":"https://github.com/o/r/compare/old111...new222"'

when "сравнение недоступно — как раньше, предупреждение в лог" "${FP[@]}" GH_COMPARE_FAIL="HTTP 502: Bad Gateway"
sent "⚠️ 1 коммит (force-push)" "!ветка" "Открыть изменения"
if grep -qF "::warning::Не сравнил ветку с main" "$TMP/out"; then pass; else fail "нет ::warning::"; fi

when "сравнение недоступно и в событии нет новых коммитов — молчим" "${FP[@]}" \
  GH_COMPARE_FAIL="HTTP 502: Bad Gateway" COMMITS='[{"id":"0000000aaaa","message":"m","distinct":false}]'
silent

when "другая ветка по умолчанию" "${FP[@]}" DEFAULT_BRANCH=develop GH_COMPARE='{"commits":[]}'
sent "ветка сброшена до develop" "/compare/develop...task-infra-1"

when "ветка со слешем в имени" "${FP[@]}" BRANCH=refs/heads/feature/web-5 GH_COMPARE='{"commits":[]}'
sent "<a href=\"https://github.com/$INFRA/tree/feature/web-5\">feature/web-5</a>" \
  "\"url\":\"https://github.com/$INFRA/compare/main...feature/web-5\""

when "удаление ветки молчит" "${FP[@]}" DELETED=true COMMITS='[]'
silent

# --- pull request и ревью

when "pr opened без ревьюверов: только автор" \
  EVENT=pull_request ACTION=opened DRAFT=false BASE=main NUMBER=7 TITLE='WEB-5: Вход' URL=https://github.com/o/r/pull/7 \
  PR_AUTHOR=YarikMix REVIEWERS='[]'
sent_to 1 26 "🔀 Открыт pull request" "WEB-5: Вход" 'автор: <a href="tg://user?id=111">YarikMix</a>' "!ревьювер"
only 1

when "review requested позже: в Code Review, пинг ревьювера" \
  EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$LONG_AGO" NUMBER=7 TITLE=t URL=u
sent_to 1 77 "👀 Запрошено ревью" \
  'автор: YarikMix · ревьювер: <a href="tg://user?id=222">blackHATred</a>'
only 1

when "pr review requested у команды молчит" \
  EVENT=pull_request ACTION=review_requested REVIEWER= NUMBER=7 TITLE=t URL=u
silent

when "pr влит в main" \
  EVENT=pull_request ACTION=closed MERGED=true BASE=main NUMBER=7 TITLE=t URL=u
sent_to 1 26 "🎉 Влито в main"

when "pr закрыт без мержа" \
  EVENT=pull_request ACTION=closed MERGED=false BASE=main NUMBER=7 TITLE=t URL=u
sent "🚫 PR закрыт без мержа"

when "review approved: в Code Review, пинг автора PR, ревьювер текстом" \
  EVENT=pull_request_review ACTION=submitted REVIEW=approved PR_AUTHOR=blackHATred REVIEW_BY=YarikMix NUMBER=7 TITLE=t URL=u
sent_to 1 77 "👍 Апрув" 'автор: <a href="tg://user?id=222">blackHATred</a> · ревьювер: YarikMix' "!комментари"

when "review changes requested: в Code Review, пинг автора PR" \
  EVENT=pull_request_review ACTION=submitted REVIEW=changes_requested PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent_to 1 77 "✋ Запрошены правки" 'tg://user?id=222'

when "review неизвестного вида молчит" \
  EVENT=pull_request_review ACTION=submitted REVIEW=dismissed PR_AUTHOR=blackHATred REVIEW_BY=YarikMix NUMBER=7 TITLE=t URL=u
silent

when "без карты: логин текстом, сторона — имя репозитория" \
  EVENT=pull_request ACTION=opened DRAFT=false MAP= REPO=Cringe-Driven-Development-Team/.github NUMBER=1 TITLE=t URL=u \
  PR_AUTHOR=YarikMix
sent "· .github" "автор: YarikMix" "!tg://user"

# --- правки при переносе в .github

when "draft pr opened молчит" \
  EVENT=pull_request ACTION=opened DRAFT=true BASE=main NUMBER=7 TITLE=t URL=u
silent

when "draft переведён в ready" \
  EVENT=pull_request ACTION=ready_for_review DRAFT=false BASE=main NUMBER=7 TITLE='WEB-5: Вход' URL=u
sent "🔀 Открыт pull request" "WEB-5: Вход"

when "push: коммиты из main не показываются" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=false \
  COMMITS='[{"id":"ddddddd4444","message":"Merge branch main into web-5","distinct":true},{"id":"bbbbbbb2222","message":"fix: из main","distinct":false}]'
sent "⚒️ 1 коммит" "• ddddddd Merge branch main into web-5" "!bbbbbbb"

when "push: только чужие коммиты молчит" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=false \
  COMMITS='[{"id":"bbbbbbb2222","message":"fix: из main","distinct":false}]'
silent

when "pr влит не в main, имя ветки экранировано" \
  EVENT=pull_request ACTION=closed MERGED=true BASE='exp<1>' NUMBER=7 TITLE=t URL=u
sent "🎉 Влито в exp&lt;1&gt;" "!Влито в main"

when "нет токена" TOKEN= EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u
error "TELEGRAM_BOT_TOKEN"

when "нет чата" CHAT= EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u
error "TELEGRAM_CHAT_ID"

# --- ревьюверы в сообщениях о PR

when "pr opened с ревьюверами из формы" \
  EVENT=pull_request ACTION=opened DRAFT=false NUMBER=7 TITLE=t URL=u PR_AUTHOR=YarikMix \
  REVIEWERS='[{"login":"blackHATred"},{"login":"iRedTea"}]'
sent_to 1 26 "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: blackHATred, iRedTea' "!tg://user?id=222"
sent_to 2 77 "👀 Запрошено ревью" \
  'автор: YarikMix · ревьювер: <a href="tg://user?id=222">blackHATred</a>, iRedTea' "!tg://user?id=111"
only 2

when "ready: ревьюверы, выбранные в черновике" \
  EVENT=pull_request ACTION=ready_for_review DRAFT=false NUMBER=7 TITLE=t URL=u ACTOR=iRedTea \
  PR_AUTHOR=YarikMix REVIEWERS='[{"login":"blackHATred"}]'
sent_to 1 26 "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: blackHATred' "!tg://user?id=222"
sent_to 2 77 "👀 Запрошено ревью" \
  'автор: YarikMix · ревьювер: <a href="tg://user?id=222">blackHATred</a>'
only 2

when "без TELEGRAM_REVIEW_TOPIC_ID: оба сообщения в обычный топик" \
  REVIEW_TOPIC= EVENT=pull_request ACTION=opened DRAFT=false NUMBER=7 TITLE=t URL=u PR_AUTHOR=YarikMix \
  REVIEWERS='[{"login":"blackHATred"}]'
sent_to 1 26 "🔀 Открыт pull request"
sent_to 2 26 "👀 Запрошено ревью"

when "без TELEGRAM_REVIEW_TOPIC_ID: апрув в обычный топик" \
  REVIEW_TOPIC= EVENT=pull_request_review ACTION=submitted REVIEW=approved PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent_to 1 26 "👍 Апрув"

when "review requested у черновика молчит" \
  EVENT=pull_request ACTION=review_requested DRAFT=true REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$LONG_AGO" NUMBER=7 TITLE=t URL=u
silent

when "review requested из формы создания молчит" \
  EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$JUST_NOW" NUMBER=7 TITLE=t URL=u
silent

# --- повторный запрос ревью после правок

BACK=go-park-mail-ru/2026_2_Cringe_Driven_Development
# review <логин> <состояние> <коммит> — одно ревью в ответе GET /pulls/N/reviews
review() { printf '{"user":{"login":"%s"},"state":"%s","commit_id":"%s"}' "$1" "$2" "$3"; }
RE=(EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix
    PR_CREATED="$LONG_AGO" REPO="$BACK" NUMBER=12 TITLE='API-3: Проект' URL=u HEAD_SHA=bbb222)

when "повторное после запроса правок: число коммитов и кнопка на diff" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred CHANGES_REQUESTED aaa111)]" GH_COMPARE='{"ahead_by":3}'
sent_to 1 77 "<b>🔁 Повторное ревью</b> · backend" \
  'автор: YarikMix · ревьювер: <a href="tg://user?id=222">blackHATred</a>' \
  "после твоего ревью (✋ правки): 3 коммита" \
  "\"text\":\"Что изменилось\",\"url\":\"https://github.com/$BACK/pull/12/files/aaa111..bbb222\"" \
  "!👀"
only 1

when "повторное после апрува, 1 коммит" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred APPROVED aaa111)]" GH_COMPARE='{"ahead_by":1}'
sent "🔁 Повторное ревью" "после твоего ревью (👍 апрув): 1 коммит"

when "повторное после комментариев" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred COMMENTED aaa111)]" GH_COMPARE='{"ahead_by":5}'
sent "после твоего ревью (💬 комментарии): 5 коммитов"

when "повторное после снятого ревью" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred DISMISSED aaa111)]" GH_COMPARE='{"ahead_by":2}'
sent "после твоего ревью (ревью снято): 2 коммита"

when "новых коммитов нет — без кнопки" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred CHANGES_REQUESTED aaa111)]" GH_COMPARE='{"ahead_by":0}'
sent "после твоего ревью (✋ правки): новых коммитов нет" "!Что изменилось"

when "force-push: коммита ревью больше нет — только вердикт" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred CHANGES_REQUESTED aaa111)]" GH_COMPARE_FAIL="HTTP 404: Not Found"
sent "🔁 Повторное ревью" "после твоего ревью (✋ правки)" "!правки):" "!Что изменилось"

when "сравнение без числа — только вердикт, без падения" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred CHANGES_REQUESTED aaa111)]" GH_COMPARE='{}'
sent "🔁 Повторное ревью" "после твоего ревью (✋ правки)" "!правки):" "!Что изменилось"

when "берётся последнее ревью этого ревьювера" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred CHANGES_REQUESTED aaa111),$(review ManInTheCoat APPROVED ccc333),$(review blackHATred COMMENTED ddd444)]" \
  GH_COMPARE='{"ahead_by":2}'
sent "после твоего ревью (💬 комментарии): 2 коммита" "/files/ddd444..bbb222"

when "ревьюил другой человек — это первый запрос" "${RE[@]}" \
  GH_REVIEWS="[$(review ManInTheCoat CHANGES_REQUESTED aaa111)]"
sent_to 1 77 "👀 Запрошено ревью" "!🔁" "!после твоего ревью"

when "неотправленное ревью (PENDING) не считается" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred PENDING aaa111)]"
sent "👀 Запрошено ревью" "!🔁"

when "API не отдал ревью — обычный запрос и предупреждение в лог" "${RE[@]}" \
  GH_REVIEWS_FAIL="HTTP 403: Resource not accessible by integration"
sent_to 1 77 "👀 Запрошено ревью" "!🔁"
if grep -qF "::warning::" "$TMP/out" && grep -qF "HTTP 403" "$TMP/out"; then pass; else fail "нет ::warning:: с причиной"; fi

# --- кнопки

for A in opened closed reopened; do
  when "кнопка у задачи: $A" EVENT=issues ACTION=$A NUMBER=5 TITLE=t URL=https://github.com/o/r/issues/5 ASSIGNEES='[]'
  sent '"text":"Открыть задачу","url":"https://github.com/o/r/issues/5"'
done

when "кнопка у правки описания" \
  EVENT=issues ACTION=edited NUMBER=5 TITLE=t URL=https://github.com/o/r/issues/5 BODY=новое CHG_BODY='{"from":"старое"}' \
  ASSIGNEES='[]' CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T11:00:00Z
sent '"text":"Открыть задачу"'

when "открыт PR с ревьювером: «Открыть PR» в общем топике, «Начать ревью» в ревью" \
  EVENT=pull_request ACTION=opened DRAFT=false NUMBER=7 TITLE=t URL=https://github.com/o/r/pull/7 PR_AUTHOR=YarikMix \
  REVIEWERS='[{"login":"blackHATred"}]'
sent_to 1 26 '"text":"Открыть PR","url":"https://github.com/o/r/pull/7"'
sent_to 2 77 '"text":"Начать ревью","url":"https://github.com/o/r/pull/7/files"'

when "кнопка у влитого PR" EVENT=pull_request ACTION=closed MERGED=true BASE=main NUMBER=7 TITLE=t URL=https://github.com/o/r/pull/7
sent '"text":"Открыть PR","url":"https://github.com/o/r/pull/7"'

when "кнопка у PR, закрытого без мержа" EVENT=pull_request ACTION=closed MERGED=false BASE=main NUMBER=7 TITLE=t URL=https://github.com/o/r/pull/7
sent '"text":"Открыть PR"'

when "кнопка у запроса ревью" \
  EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$LONG_AGO" NUMBER=7 TITLE=t URL=https://github.com/o/r/pull/7
sent '"text":"Начать ревью","url":"https://github.com/o/r/pull/7/files"'

when "повторное ревью без новых коммитов — «Начать ревью»" "${RE[@]}" \
  GH_REVIEWS="[$(review blackHATred CHANGES_REQUESTED aaa111)]" GH_COMPARE='{"ahead_by":0}'
sent "🔁 Повторное ревью" '"text":"Начать ревью"' "!Что изменилось"

# --- ревью с комментариями

# rv <id> <логин> <состояние> <время> [общий текст] — ревью в ответе GET /pulls/N/reviews
rv() {
  jq -nc --argjson id "$1" --arg u "$2" --arg st "$3" --arg at "$4" --arg body "${5-}" \
    '{id: $id, user: {login: $u}, state: $st, submitted_at: $at, body: $body, commit_id: "aaa111",
      html_url: "https://github.com/o/r/pull/12#pullrequestreview-\($id)"}'
}
# inline <id ревью>… — inline-комментарии в ответе GET /pulls/N/comments
inline() { printf '%s\n' "$@" | jq -sc 'map({pull_request_review_id: .})'; }
CM=(EVENT=pull_request_review ACTION=submitted REVIEW=commented PR_AUTHOR=blackHATred REVIEW_BY=YarikMix
    REPO="$BACK" NUMBER=12 TITLE='API-3: Проект' URL=u REVIEW_URL=https://github.com/o/r/pull/12#pullrequestreview-9)

when "один комментарий: пинг автора, ревьювер текстом, кнопка" "${CM[@]}" \
  GH_REVIEWS="[$(rv 9 YarikMix COMMENTED 2026-09-20T10:00:00Z)]" GH_COMMENTS="$(inline 9)"
sent_to 1 77 "<b>💬 Комментарии к PR</b> · backend" \
  'автор: <a href="tg://user?id=222">blackHATred</a> · ревьювер: YarikMix' "1 комментарий" \
  '"text":"Открыть ревью","url":"https://github.com/o/r/pull/12#pullrequestreview-9"' "!tg://user?id=111"
only 1

when "серия одиночных комментариев — одно число, кнопка на первое ревью серии" "${CM[@]}" \
  GH_REVIEWS="[$(rv 7 YarikMix COMMENTED 2026-09-20T10:00:00Z),$(rv 8 YarikMix COMMENTED 2026-09-20T10:02:00Z),$(rv 9 YarikMix COMMENTED 2026-09-20T10:04:30Z)]" \
  GH_COMMENTS="$(inline 7 8 8 9)"
sent "4 комментария" "pullrequestreview-7" "!pullrequestreview-9"

when "пауза 3 минуты и больше разрывает серию" "${CM[@]}" \
  GH_REVIEWS="[$(rv 7 YarikMix COMMENTED 2026-09-20T10:00:00Z),$(rv 8 YarikMix COMMENTED 2026-09-20T10:03:00Z),$(rv 9 YarikMix COMMENTED 2026-09-20T10:04:00Z)]" \
  GH_COMMENTS="$(inline 7 7 7 8 9)"
sent "2 комментария" "pullrequestreview-8"

when "общий текст ревью считается комментарием" "${CM[@]}" \
  GH_REVIEWS="[$(rv 9 YarikMix COMMENTED 2026-09-20T10:00:00Z "В целом ок, но…")]" GH_COMMENTS="$(inline 9 9 9 9)"
sent "5 комментариев"

when "чужие ревью и комментарии не считаются" "${CM[@]}" \
  GH_REVIEWS="[$(rv 8 ManInTheCoat COMMENTED 2026-09-20T10:03:00Z),$(rv 9 YarikMix COMMENTED 2026-09-20T10:04:00Z)]" \
  GH_COMMENTS="$(inline 8 8 9)"
sent "1 комментарий" "!2 комментария"

when "апрув после серии комментариев — со строкой комментариев" "${CM[@]}" REVIEW=approved \
  GH_REVIEWS="[$(rv 8 YarikMix COMMENTED 2026-09-20T10:00:00Z),$(rv 9 YarikMix APPROVED 2026-09-20T10:01:00Z)]" \
  GH_COMMENTS="$(inline 8 8)"
sent_to 1 77 "👍 Апрув" "2 комментария" "Открыть ревью"
only 1

when "запрошены правки с inline-комментариями" "${CM[@]}" REVIEW=changes_requested \
  GH_REVIEWS="[$(rv 9 YarikMix CHANGES_REQUESTED 2026-09-20T10:00:00Z "Поправь")]" GH_COMMENTS="$(inline 9 9)"
sent "✋ Запрошены правки" "3 комментария"

when "апрув без комментариев — без строки и кнопки" "${CM[@]}" REVIEW=approved \
  GH_REVIEWS="[$(rv 9 YarikMix APPROVED 2026-09-20T10:00:00Z)]"
sent "👍 Апрув" "!комментари" "!Открыть ревью"

when "автор отвечает в ветке обсуждения — молчим" "${CM[@]}" REVIEW_BY=blackHATred
silent

when "ревью бота — молчим" "${CM[@]}" REVIEW_BY=some-bot REVIEW_BY_TYPE=Bot
silent

when "API не отдал ревью — сообщение без числа, предупреждение в лог" "${CM[@]}" \
  GH_REVIEWS_FAIL="HTTP 403: Resource not accessible by integration"
sent_to 1 77 "💬 Комментарии к PR" "Открыть ревью" "pullrequestreview-9" "!комментари"
if grep -qF "::warning::" "$TMP/out"; then pass; else fail "нет ::warning::"; fi

when "API не отдал inline-комментарии — сообщение без числа" "${CM[@]}" \
  GH_REVIEWS="[$(rv 9 YarikMix COMMENTED 2026-09-20T10:00:00Z)]" GH_COMMENTS_FAIL="HTTP 502"
sent "💬 Комментарии к PR" "!комментари"

summary
