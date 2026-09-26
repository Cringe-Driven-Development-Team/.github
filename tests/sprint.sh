#!/usr/bin/env bash
# Прогоняет scripts/sprint.sh на подставных ответах GitHub.
# gh подменён заглушкой: чтение доски — фикстура, мутация Sprint — запись в $TMP/moves.
# Нужны bash, jq и GNU date (через jq strptime/mktime, самого date не вызываем).
# Запуск: bash tests/sprint.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/tests/lib.sh"
SCRIPT="$ROOT/scripts/sprint.sh"

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# заглушка gh: мутация Sprint (query=mutation...) — пишет "item iteration project field token" в
# $MOVES (token — значение GH_TOKEN, которым скрипт вызвал gh), для itemId из MOVE_FAIL (через
# пробел) отвечает отказом; иначе это чтение доски — GH_FAIL валит запрос, без --paginate отдаётся
# только первая "страница" фикстуры (ловит потерю флага пагинации), с --paginate — все подряд
args=("$@")
QUERY="" ITEM="" ITERATION="" PROJECT="" FIELD="" PAGINATE=""
for a in "${args[@]}"; do
  case "$a" in
    query=*) QUERY=${a#query=} ;;
    item=*) ITEM=${a#item=} ;;
    iteration=*) ITERATION=${a#iteration=} ;;
    project=*) PROJECT=${a#project=} ;;
    field=*) FIELD=${a#field=} ;;
    --paginate) PAGINATE=1 ;;
  esac
done
case "$QUERY" in
  mutation*)
    case " ${MOVE_FAIL:-} " in
      *" $ITEM "*) echo "gh: HTTP 502" >&2; exit 1 ;;
    esac
    printf '%s %s %s %s %s\n' "$ITEM" "$ITERATION" "$PROJECT" "$FIELD" "${GH_TOKEN:-}" >> "$MOVES"
    echo '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"'"$ITEM"'"}}}}' ;;
  *)
    [ -z "${GH_FAIL:-}" ] || { echo "gh: HTTP 502" >&2; exit 1; }
    if [ -n "$PAGINATE" ]; then cat "$FIXTURE"; else head -n 1 "$FIXTURE"; fi ;;
esac
STUB
chmod +x "$TMP/bin/gh"

FIXTURE="$TMP/fixture.json"
MOVES="$TMP/moves"
DEFAULTS=(
  TOKEN=test-token CHAT=-100 TOPIC=26 MAP='{"YarikMix":"111","blackHATred":"222"}'
  PAT=test-pat TODAY=2026-09-28 GH_FAIL= MOVE_FAIL= ANNOUNCE_EMPTY=true
  FIXTURE="$FIXTURE" MOVES="$MOVES"
)

# w "название" ... — как when из lib.sh, но ещё чистит журнал мутаций перед прогоном
w() { rm -f "$TMP/moves"; when "$@"; }

# iter <id> <title> <start> [duration=7] — итерация поля Sprint
iter() {
  jq -nc --arg id "$1" --arg title "$2" --arg start "$3" --argjson duration "${4:-7}" \
    '{id: $id, title: $title, startDate: $start, duration: $duration}'
}

# item <id> <sprint-id|-> <status|-> <issue|pr|draft|null> <state> <репозиторий> <номер> <заголовок> [логины…]
#   kind=null — content: null (задача удалена/недоступна), остальные поля игнорируются;
#   kind=draft — черновик доски: номер/repo/state не нужны GraphQL-схемой, тоже игнорируются
item() {
  local id=$1 sprint=$2 status=$3 kind=$4 state=$5 repo=$6 number=$7 title=$8
  shift 8
  jq -nc --arg id "$id" --arg sprint "$sprint" --arg status "$status" --arg kind "$kind" \
    --arg state "$state" --arg repo "$repo" --arg number "$number" --arg title "$title" '
    {
      id: $id,
      isArchived: false,
      content: (
        if $kind == "null" then null
        elif $kind == "draft" then {__typename: "DraftIssue", title: $title,
          assignees: {nodes: [$ARGS.positional[] | {login: .}]}}
        else {
          __typename: (if $kind == "issue" then "Issue" else "PullRequest" end),
          number: ($number | tonumber), title: $title,
          url: "https://github.com/\($repo)/\(if $kind == "issue" then "issues" else "pull" end)/\($number)",
          state: $state, repository: {nameWithOwner: $repo},
          assignees: {nodes: [$ARGS.positional[] | {login: .}]}
        } end
      ),
      sprint: (if $sprint == "-" then null else {iterationId: $sprint} end),
      status: (if $status == "-" then null else {name: $status} end)
    }' --args "$@"
}
archived() { item "$@" | jq -c '.isArchived = true'; }

PROJECT_ID=PVT_test
PROJECT_URL=https://github.com/orgs/Cringe-Driven-Development-Team/projects/1
FIELD_ID=PVTIF_test

# итерации фикстуры по умолчанию: Sprint 1..4, понедельник-воскресенье подряд
S1=$(iter s1 "Sprint 1" 2026-09-14)
S2=$(iter s2 "Sprint 2" 2026-09-21)
S3=$(iter s3 "Sprint 3" 2026-09-28)
S4=$(iter s4 "Sprint 4" 2026-10-05)
ITERS=("$S1" "$S2" "$S3" "$S4")

# page <hasNextPage> <endCursor|-пусто-> <item>… — одна "страница" ответа GraphQL (итерации — из $ITERS)
page() {
  local hasNext=$1 cursor=$2 items iters
  shift 2
  items=$(printf '%s\n' "$@" | jq -s '.')
  iters=$(printf '%s\n' "${ITERS[@]}" | jq -s '.')
  jq -nc --arg pid "$PROJECT_ID" --arg url "$PROJECT_URL" --arg fid "$FIELD_ID" \
    --argjson iters "$iters" --argjson items "$items" --argjson hasNext "$hasNext" --arg cursor "$cursor" '
    {data: {organization: {projectV2: {
      id: $pid, url: $url,
      field: {id: $fid, configuration: {iterations: $iters, completedIterations: []}},
      items: {pageInfo: {hasNextPage: $hasNext, endCursor: (if $cursor == "" then null else $cursor end)}, nodes: $items}
    }}}}'
}

# fixture <item>… — ответ доски одной страницей
fixture() { page false "" "$@" > "$FIXTURE"; }

# --- 1. первый день, три хвоста в разном статусе, в новом спринте уже есть задача;
#        плюс задачи вне области переноса (без спринта, в чужом спринте, уже в новом) — доска не «протекает»

D1=$(item d1 s2 Done issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 10 "Done issue")
D2=$(item d2 s2 "In review" pr MERGED frontend-park-mail-ru/2026_2_Cringe_Driven_Development 11 "Merged PR")
T1=$(item t1 s2 "In review" issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 12 "Tail in review" blackHATred)
T2=$(item t2 s2 "In progress" issue OPEN frontend-park-mail-ru/2026_2_Cringe_Driven_Development 13 "Tail in progress" YarikMix)
T3=$(item t3 s2 Backlog issue OPEN Cringe-Driven-Development-Team/infra 14 "Tail backlog" SomeoneElse)
E1=$(item e1 s3 Ready issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 20 "Existing sprint3" MrDuckVC)
E2=$(item e2 s3 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 21 "Second sprint3 item" SomeoneNew)
NS=$(item ns1 - Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 15 "No sprint item" GhostLogin)
S1X=$(item s1x s1 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 16 "Sprint1 stray item" GhostLogin)
fixture "$D1" "$D2" "$T1" "$T2" "$T3" "$E1" "$E2" "$NS" "$S1X"
w "1. первый день: 2 сделанных, 3 хвоста, итог и план; без спринта и в чужом спринте не участвуют"
sent_to 1 26 "🏁 Sprint 2 закрыт · 21.09–27.09" "сделано 2 из 5" "перенесено в Sprint 3 — 3:" \
  '<a href="tg://user?id=222">blackHATred</a>' '<a href="tg://user?id=111">YarikMix</a>' "SomeoneElse" \
  "🚀 Sprint 3 · 28.09–04.10" "5 задач:" "SomeoneNew 1" '"text":"Открыть доску"' \
  "!GhostLogin" "!No sprint item" "!Sprint1 stray item"
before "In review" "In progress"
before "In progress" "Backlog"
only 1
if [ "$(sort "$TMP/moves")" = "$(printf 't1 s3 PVT_test PVTIF_test test-pat\nt2 s3 PVT_test PVTIF_test test-pat\nt3 s3 PVT_test PVTIF_test test-pat\n' | sort)" ]
then pass
else fail "журнал мутаций (item iteration project field token): $(cat "$TMP/moves" 2>/dev/null)"; fi

# --- 2. первый день, хвостов нет

D1=$(item d1 s2 Done issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 30 "Done A")
D2=$(item d2 s2 Done issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 31 "Done B")
fixture "$D1" "$D2"
w "2. первый день, хвостов нет — «всё сделано»; план пуст — без висячего двоеточия"
sent "всё сделано 🎉" "сделано 2 из 2" "🚀 Sprint 3 · 28.09–04.10" "0 задач" "!0 задач:"
only 1
[ -s "$TMP/moves" ] && fail "были мутации" || pass

# --- 2b. первый день, хвостов нет, но ANNOUNCE_EMPTY=false (ручной прогон/повтор) — тишина,
#         чтобы не постить одно и то же «всё сделано» по новой

fixture "$D1" "$D2"
w "2b. первый день, хвостов нет, ANNOUNCE_EMPTY=false — тишина" ANNOUNCE_EMPTY=false
silent
[ -s "$TMP/moves" ] && fail "были мутации" || pass

# --- 3. закрытая задача не в Done и смерженный PR — сделаны, не хвосты

C1=$(item c1 s2 "In progress" issue CLOSED go-park-mail-ru/2026_2_Cringe_Driven_Development 40 "Closed issue")
M1=$(item m1 s2 Ready pr MERGED frontend-park-mail-ru/2026_2_Cringe_Driven_Development 41 "Merged PR")
fixture "$C1" "$M1"
w "3. закрытая задача и смерженный PR — сделаны без статуса Done"
sent "сделано 2 из 2" "всё сделано 🎉" "!In progress" "!Ready"
[ -s "$TMP/moves" ] && fail "были мутации" || pass

# --- 4. архив и content:null — не считаются и не переносятся

A1=$(archived a1 s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 50 "Archived tail")
N1=$(item n1 s2 Backlog null - - - -)
fixture "$A1" "$N1"
w "4. архивная и content:null задачи — не в «из Y», не переносятся"
sent "всё сделано 🎉" "сделано 0 из 0"
[ -s "$TMP/moves" ] && fail "были мутации" || pass

# --- 5. черновик-хвост

DR=$(item dr1 s2 Ready draft - - - "Придумать название")
fixture "$DR"
w "5. черновик — хвост без ссылки, но переносится"
sent "черновик · Придумать название" "!<a href=\""
if grep -q "^dr1 s3 " "$TMP/moves"; then pass; else fail "черновик не перенесён"; fi

# --- 6. второй день, хвост остался

T1=$(item t1b s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 60 "Late tail")
fixture "$T1"
w "6. второй день, хвост остался — перенос всё равно происходит" TODAY=2026-09-29
sent "перенесено в Sprint 3 — 1:" "Late tail"
if grep -q "^t1b s3 " "$TMP/moves"; then pass; else fail "нет переноса"; fi

# --- 7. второй день, хвостов нет

fixture
w "7. второй день, хвостов нет — тишина" TODAY=2026-09-29
silent
[ -s "$TMP/moves" ] && fail "мутации были" || pass

# --- 8. последний день текущего спринта (не первый), без хвостов из прошлого — тишина;
#        незакрытая задача текущего (ещё не прошлого) спринта — не хвост и не переносится

X1=$(item x1 s2 "In progress" issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 200 "Last day sprint2 item")
fixture "$X1"
w "8. последний день спринта — не первый день, хвостов из прошлого нет" TODAY=2026-09-27
silent
[ -s "$TMP/moves" ] && fail "мутации были" || pass

# --- 9. нет текущей итерации, хвосты есть

ITERS=("$S1" "$S2")
T1=$(item t1c s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 70 "No home tail")
fixture "$T1"
w "9. нет текущего спринта, один хвост — предупреждение с пингом владельца, глагол в ед. числе"
sent "⚠️ Sprint 2 закончился" "а следующего спринта на доске нет" "1 задача не перенесена" \
  "tg://user?id=111" "!не перенесены"
[ -s "$TMP/moves" ] && fail "были мутации" || pass
ITERS=("$S1" "$S2" "$S3" "$S4")

# --- 10. нет прошлой итерации

fixture
w "10. нет прошлой итерации — тишина" TODAY=2026-09-14
silent

# --- 11a. Telegram отклонил сообщение — сначала шлём, потом переносим: отказ валит job
#          до единой мутации, доска остаётся нетронутой

T1=$(item tr1 s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 82 "Reject tail")
fixture "$T1"
w "11a. Telegram отклонил сообщение — код 1, ни одна мутация не прошла" TG_REJECT='🏁'
error "Telegram отклонил"
[ -s "$TMP/moves" ] && fail "мутации прошли при отклонённом сообщении" || pass

# --- 11b. сбой одной мутации не останавливает перенос остальных: основное сообщение перечисляет
#          все хвосты как если бы перенос удался (без инлайн-пометки), непереехавшим — отдельное
#          сообщение-напоминание с кнопкой на доску

T1=$(item ta s2 "In review" issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 80 "Tail A" GrayMouse9)
T2=$(item tb s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 81 "Tail B" GrayMouse9)
fixture "$T1" "$T2"
w "11b. сбой одной мутации: остальные перенесены, доп. сообщение с непереехавшими" MOVE_FAIL=tb
if [ "$CODE" -eq 0 ]; then pass; else fail "код $CODE"; fi
if grep -q "^ta s3 " "$TMP/moves" && ! grep -q '^tb ' "$TMP/moves"; then pass
else fail "журнал мутаций: $(cat "$TMP/moves" 2>/dev/null)"; fi
sent_to 1 26 "Tail A" "Tail B" "!⚠️ не перенесена"
sent_to 2 26 "⚠️ Не перенесены в Sprint 3" "перенесите руками" "Tail B" "!Tail A"
only 2
if grep -qF "::warning::Не перенёс" "$TMP/out"; then pass; else fail "нет ::warning::"; fi

# --- 12. больше 20 хвостов

prs=()
for i in $(seq 1 22); do
  prs+=("$(item "tail$i" s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development "$((100 + i))" "Tail $i")")
done
fixture "${prs[@]}"
w "12. больше 20 хвостов — обрезка списка и «…и ещё N»"
sent "…и ещё 2"
if [ "$(grep -c '^• ' "$TMP/sent/1")" -eq 20 ]; then pass; else fail "строк хвостов не 20"; fi
if [ "$(wc -l < "$TMP/moves")" -eq 22 ]; then pass; else fail "перенесены не все 22"; fi

# --- 13. PAT недоступен

fixture
w "13. PAT недоступен — тишина и предупреждение" PAT=
silent
if grep -qF "::warning::ADD_TO_PROJECT_PAT недоступен" "$TMP/out"; then pass; else fail "нет ::warning::"; fi

# --- 14. доска недоступна

w "14. доска недоступна — ошибка и код 1" GH_FAIL=1
error "Не прочитал доску"

# --- 15. экранирование заголовка и логина

T1=$(item tc s2 "In review" issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 90 "Фикс <b> & ко" NobodyInMap)
fixture "$T1"
w "15. заголовок и логин вне карты экранируются"
sent "Фикс &lt;b&gt; &amp; ко" "NobodyInMap" "!<b>Фикс" "!tg://user?id"

# --- 16. Review Focus: две страницы пагинации

P1A=$(item pa s2 "In review" issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 100 "Page1 tail A" GrayMouse9)
P1B=$(item pb s2 Done issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 101 "Page1 done")
P2A=$(item pc s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 102 "Page2 tail")
{ page true c1 "$P1A" "$P1B"; page false "" "$P2A"; } > "$FIXTURE"
w "16. Review Focus: задачи на двух страницах — все учтены"
sent "сделано 1 из 3" "перенесено в Sprint 3 — 2:" "Page1 tail A" "Page2 tail"
only 1
if [ "$(wc -l < "$TMP/moves")" -eq 2 ]; then pass; else fail "перенос не по всем страницам"; fi

# --- 17. Review Focus: два исполнителя у одного хвоста

T1=$(item td s2 Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 110 "Duo tail" blackHATred YarikMix)
fixture "$T1"
w "17. Review Focus: хвост с двумя исполнителями — оба пинга и оба +1 в плане"
sent '<a href="tg://user?id=222">blackHATred</a>' '<a href="tg://user?id=111">YarikMix</a>' \
  "1 задача:" "YarikMix 1" "blackHATred 1"

# --- 18. Review Focus: спринт длиной 14 дней, середина — с хвостом-приманкой в самом 14-дневном
#         спринте: если duration игнорировать (взять как 7), этот спринт «закончится» раньше и
#         его незакрытая задача превратится в хвост несуществующего текущего — уйдёт предупреждение;
#         при верном учёте duration это по-прежнему середина текущего спринта — тишина

ITERS=("$(iter s1b "Sprint 1" 2026-09-07 7)" "$(iter s2b "Sprint 2" 2026-09-14 14)")
X1=$(item x1 s2b Backlog issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 140 "Mid-sprint item")
fixture "$X1"
w "18. Review Focus: двухнедельный спринт, середина — не первый день, тишина (duration учитывается)" TODAY=2026-09-21
silent
[ -s "$TMP/moves" ] && fail "были мутации" || pass
ITERS=("$S1" "$S2" "$S3" "$S4")

# --- 19. экранирование заголовка текущего спринта и произвольного (не из ORDER) статуса

S3X=$(iter s3 "Sprint <3> & co" 2026-09-28)
ITERS=("$S1" "$S2" "$S3X" "$S4")
TE=$(item te s2 "In <review>" issue OPEN go-park-mail-ru/2026_2_Cringe_Driven_Development 150 "Escaped status tail")
fixture "$TE"
w "19. заголовок текущего спринта в «перенесено в …» и произвольный статус хвоста экранируются"
sent "Sprint &lt;3&gt; &amp; co" "In &lt;review&gt;" "!Sprint <3>" "!In <review>"
ITERS=("$S1" "$S2" "$S3" "$S4")

summary
