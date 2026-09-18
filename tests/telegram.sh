#!/usr/bin/env bash
# Прогоняет скрипт из .github/workflows/telegram.yml на подставных событиях.
# Нужны bash, jq, perl, GNU date и awk. Запуск: bash tests/telegram.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/tests/lib.sh"

SCRIPT="$TMP/script.sh"
awk -f "$ROOT/tests/extract-run.awk" "$ROOT/.github/workflows/telegram.yml" > "$SCRIPT"
[ -s "$SCRIPT" ] || { echo "в telegram.yml не найден блок run: |"; exit 1; }

# так GitHub заполняет env: отсутствующее поле события — пустая строка, toJSON(null) — null.
# ID в карте и топиках ненастоящие: репозиторий публичный.
DEFAULTS=(
  TOKEN=test-token CHAT=-100 TOPIC=26 REVIEW_TOPIC=77 MAP='{"YarikMix":"111","blackHATred":"222"}'
  EVENT= ACTION= MERGED= DRAFT= BASE= REVIEW= REVIEWER= PR_AUTHOR=
  ACTOR=YarikMix REPO=Cringe-Driven-Development-Team/react
  NUMBER= TITLE= URL= BRANCH= COMMITS=null COMPARE= FORCED=
  BODY= ASSIGNEES=null CREATED= UPDATED= CHG_BODY=null
  REVIEWERS=null PR_CREATED=
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
  "<blockquote expandable>Что сделать" "&amp; записать" "!скрыто"

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

# --- пуши

when "push: коммиты ветки" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=https://github.com/o/r/compare/a...b FORCED=false \
  REPO=frontend-park-mail-ru/2026_2_Cringe_Driven_Development \
  COMMITS='[{"id":"aaaaaaa1111","message":"feat: первое\n\nтело","distinct":true},{"id":"ccccccc3333","message":"fix: второе","distinct":true}]'
sent "⚒️ 2 коммита" "· frontend ·" "• aaaaaaa feat: первое" "• ccccccc fix: второе" "!тело"

when "push: force-push помечен" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=true \
  COMMITS='[{"id":"aaaaaaa1111","message":"feat: первое","distinct":true}]'
sent "⚠️ 1 коммит (force-push)"

when "push: без коммитов (создание ветки) молчит" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=false COMMITS='[]'
silent

# --- pull request и ревью

when "pr opened без ревьюверов: только автор" \
  EVENT=pull_request ACTION=opened DRAFT=false BASE=main NUMBER=7 TITLE='WEB-5: Вход' URL=https://github.com/o/r/pull/7 \
  PR_AUTHOR=YarikMix REVIEWERS='[]'
sent "🔀 Открыт pull request" "WEB-5: Вход" 'автор: <a href="tg://user?id=111">YarikMix</a>' "!ревьювер"

when "review requested позже: автор и ревьювер" \
  EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$LONG_AGO" NUMBER=7 TITLE=t URL=u
sent "👀 Запрошено ревью" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: <a href="tg://user?id=222">blackHATred</a>'

when "pr review requested у команды молчит" \
  EVENT=pull_request ACTION=review_requested REVIEWER= NUMBER=7 TITLE=t URL=u
silent

when "pr влит в main" \
  EVENT=pull_request ACTION=closed MERGED=true BASE=main NUMBER=7 TITLE=t URL=u
sent "🎉 Влито в main"

when "pr закрыт без мержа" \
  EVENT=pull_request ACTION=closed MERGED=false BASE=main NUMBER=7 TITLE=t URL=u
sent "🚫 PR закрыт без мержа"

when "review approved: упомянут автор PR" \
  EVENT=pull_request_review ACTION=submitted REVIEW=approved PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent "👍 Апрув" 'tg://user?id=222'

when "review commented молчит" \
  EVENT=pull_request_review ACTION=submitted REVIEW=commented PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
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
sent "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: <a href="tg://user?id=222">blackHATred</a>, iRedTea'

when "ready: ревьюверы, выбранные в черновике" \
  EVENT=pull_request ACTION=ready_for_review DRAFT=false NUMBER=7 TITLE=t URL=u ACTOR=iRedTea \
  PR_AUTHOR=YarikMix REVIEWERS='[{"login":"blackHATred"}]'
sent "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: <a href="tg://user?id=222">blackHATred</a>'

when "review requested у черновика молчит" \
  EVENT=pull_request ACTION=review_requested DRAFT=true REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$LONG_AGO" NUMBER=7 TITLE=t URL=u
silent

when "review requested из формы создания молчит" \
  EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$JUST_NOW" NUMBER=7 TITLE=t URL=u
silent

summary
