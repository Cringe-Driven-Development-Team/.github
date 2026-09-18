#!/usr/bin/env bash
# Прогоняет scripts/reminders.sh на подставных ответах GitHub.
# gh подменён заглушкой: отдаёт $TMP/fixture.json, запрос сохраняет в $TMP/query.
# Нужны bash, jq и GNU date. Запуск: bash tests/reminders.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/tests/lib.sh"
SCRIPT="$ROOT/scripts/reminders.sh"

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# заглушка gh api graphql: запомнить запрос, отдать фикстуру или упасть
for a in "$@"; do case "$a" in query=*) printf '%s' "${a#query=}" > "$QUERY_FILE" ;; esac; done
[ -z "${GH_FAIL:-}" ] || { echo "gh: HTTP 502" >&2; exit 1; }
cat "$FIXTURE"
STUB
chmod +x "$TMP/bin/gh"

# «сейчас» во всех случаях — 2026-09-20 12:00 UTC. ID в карте и топике ненастоящие.
DEFAULTS=(
  TOKEN=test-token CHAT=-100 TOPIC=77 MAP='{"YarikMix":"111","blackHATred":"222"}'
  MIN_HOURS=4 NOW="$(date -u -d 2026-09-20T12:00:00Z +%s)" LAST_COMMIT=2026-09-19T12:00:00Z
  FIXTURE="$TMP/fixture.json" QUERY_FILE="$TMP/query"
)

FRONT=frontend-park-mail-ru/2026_2_Cringe_Driven_Development
BACK=go-park-mail-ru/2026_2_Cringe_Driven_Development

# pr <репозиторий> <заголовок> <создан> <черновик: true|false> <что было…>
#   wait:<логин>        — логин сейчас в Reviewers
#   team                — в Reviewers команда (логина нет)
#   req:<логин>@<время> — у логина запрошено ревью
#   ready@<время>       — PR переведён из черновика в Ready
pr() {
  local repo=$1 title=$2 created=$3 draft=$4
  shift 4
  jq -nc --arg repo "$repo" --arg title "$title" --arg created "$created" --argjson draft "$draft" '
    {repo: $repo, title: $title, url: "https://github.com/\($repo)/pull/1", isDraft: $draft, createdAt: $created,
     reviewRequests: {nodes: [$ARGS.positional[]
       | (select(startswith("wait:")) | {requestedReviewer: {login: .[5:]}}),
         (select(. == "team") | {requestedReviewer: {}})]},
     timelineItems: {nodes: [$ARGS.positional[]
       | (select(startswith("req:")) | .[4:] | split("@")
          | {__typename: "ReviewRequestedEvent", createdAt: .[1], requestedReviewer: {login: .[0]}}),
         (select(startswith("ready@")) | {__typename: "ReadyForReviewEvent", createdAt: .[6:]})]}}' \
    --args "$@"
}

# fixture <pr>… — ответ GraphQL: PR разложены по своим репозиториям
fixture() {
  printf '%s\n' "$@" | jq -s '{data: (group_by(.repo) | to_entries
    | map({key: "r\(.key)", value: {nameWithOwner: .value[0].repo, pullRequests: {nodes: (.value | map(del(.repo)))}}})
    | from_entries)}' > "$TMP/fixture.json"
}

# --- кого показываем

fixture
when "нет открытых PR — тишина"
silent

when "запрос покрывает все семь репозиториев"
missing=""
for r in Cringe-Driven-Development-Team/.github Cringe-Driven-Development-Team/docs \
  Cringe-Driven-Development-Team/static Cringe-Driven-Development-Team/infra \
  Cringe-Driven-Development-Team/react "$FRONT" "$BACK"; do
  grep -qF "owner: \"${r%%/*}\", name: \"${r#*/}\"" "$TMP/query" || missing="$missing $r"
done
if [ -z "$missing" ]; then pass; else fail "в запросе нет:$missing"; fi

fixture "$(pr "$BACK" "API-3: Черновик" 2026-09-18T12:00:00Z true wait:blackHATred req:blackHATred@2026-09-18T12:00:00Z)"
when "черновик пропущен"
silent

fixture "$(pr "$BACK" "API-3: Рано" 2026-09-20T08:00:00Z false wait:blackHATred req:blackHATred@2026-09-20T08:01:00Z)"
when "3 ч 59 мин — ещё рано"
silent

fixture "$(pr "$BACK" "API-3: Порог" 2026-09-20T08:00:00Z false wait:blackHATred req:blackHATred@2026-09-20T08:00:00Z)"
when "ровно 4 ч — в дайджесте"
sent_to 1 77 "<b>⏰ Ждут ревью</b>" \
  "• backend · <a href=\"https://github.com/$BACK/pull/1\">API-3: Порог</a>" \
  '  <a href="tg://user?id=222">blackHATred</a> · ждёт 4 ч'
only 1

fixture "$(pr "$BACK" "API-3: Ready" 2026-09-18T12:00:00Z false wait:blackHATred req:blackHATred@2026-09-18T12:00:00Z ready@2026-09-20T06:00:00Z)"
when "переведён в Ready позже запроса — счёт от Ready"
sent "blackHATred</a> · ждёт 6 ч"

fixture "$(pr "$BACK" "API-3: Старый" 2026-09-19T06:00:00Z false wait:blackHATred)"
when "запроса нет в истории — счёт от создания PR"
sent "blackHATred</a> · ждёт 1 д 6 ч"

fixture "$(pr "$BACK" "API-3: Двое суток" 2026-09-18T12:00:00Z false wait:blackHATred req:blackHATred@2026-09-18T12:00:00Z)"
when "ровно двое суток — без часов"
sent "· ждёт 2 д" "!2 д 0 ч"

fixture "$(pr "$BACK" "API-3: Команда" 2026-09-18T12:00:00Z false team)"
when "запрос у команды пропущен"
silent

fixture "$(pr "$BACK" "API-3: Только что" 2026-09-20T11:55:00Z false wait:blackHATred req:blackHATred@2026-09-20T11:55:00Z)"
when "MIN_HOURS=0 — все, кто висит" MIN_HOURS=0
sent "blackHATred</a> · ждёт 0 ч"

# --- порядок и формат

fixture \
  "$(pr "$BACK" "API-3: Два ревьювера" 2026-09-19T10:00:00Z false \
     wait:YarikMix wait:blackHATred req:blackHATred@2026-09-19T10:00:00Z req:YarikMix@2026-09-20T07:00:00Z)" \
  "$(pr "$FRONT" "WEB-9: Дольше всех" 2026-09-18T12:00:00Z false wait:iRedTea req:iRedTea@2026-09-18T12:00:00Z)"
when "два ревьювера — две строки, сверху кто ждёт дольше"
sent "• frontend · " "  iRedTea · ждёт 2 д" \
  '  <a href="tg://user?id=222">blackHATred</a> · ждёт 1 д 2 ч' \
  '  <a href="tg://user?id=111">YarikMix</a> · ждёт 5 ч'
before "WEB-9: Дольше всех" "API-3: Два ревьювера"
before "blackHATred" "YarikMix"

fixture "$(pr "$BACK" "API-3: Фикс <b> & ко" 2026-09-18T12:00:00Z false wait:blackHATred)"
when "заголовок экранирован"
sent "API-3: Фикс &lt;b&gt; &amp; ко"

prs=()
for i in $(seq 1 22); do
  prs+=("$(pr "$BACK" "API-$i: PR" 2026-09-18T12:00:00Z false wait:blackHATred)")
done
fixture "${prs[@]}"
when "больше 20 PR — «…и ещё N»"
sent "…и ещё 2"
if [ "$(grep -c '^• ' "$TMP/sent/1")" -eq 20 ]; then pass; else fail "строк PR не 20"; fi

# --- предупреждение об отключении cron

fixture "$(pr "$BACK" "API-3: PR" 2026-09-18T12:00:00Z false wait:blackHATred)"
when "52 дня без коммитов — предупреждение в конце дайджеста" LAST_COMMIT=2026-07-30T12:00:00Z
sent "⏰ Ждут ревью" "⚠️ Напоминания отключатся примерно через 8 дней без коммитов в .github" \
  "gh workflow enable reminders.yml -R Cringe-Driven-Development-Team/.github"
before "API-3: PR" "⚠️"

fixture
when "59 дней без коммитов и нет PR — предупреждение отдельно" LAST_COMMIT=2026-07-23T12:00:00Z
sent_to 1 77 "примерно через 1 день" "!Ждут ревью"
only 1

fixture
when "61 день без коммитов — «в любой момент»" LAST_COMMIT=2026-07-21T12:00:00Z
sent "могут отключиться в любой момент"

fixture
when "49 дней без коммитов — без предупреждения" LAST_COMMIT=2026-08-02T12:00:00Z
silent

# --- ошибки

fixture
when "ошибка gh — выход 1" GH_FAIL=1
error "HTTP 502"

when "нет токена" TOKEN=
error "TELEGRAM_BOT_TOKEN"

summary
