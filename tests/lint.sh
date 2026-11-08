#!/usr/bin/env bash
# Проверяет все workflow: actionlint — YAML и выражения, shellcheck — скрипты из run: |.
# Встроенный в actionlint вызов shellcheck на Windows зависает, поэтому он запускается отдельно.
# Нужны actionlint, shellcheck, awk и Bun. Запуск: bash tests/lint.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# shortcut: actionlint 1.7.12 lacks queue; remove when supported (rhysd/actionlint#657).
actionlint -ignore '^unexpected key "queue" for "concurrency" section\.' -no-color -oneline -shellcheck= -pyflakes=
# Check the event gate and execute the publisher with a local Docker boundary stub.
bun test tests/auxiliary-cd.test.ts tests/auxiliary-publish.test.ts tests/webhook-workflows.test.ts tests/issue-status-workflow.test.ts tests/githubbot-workflows.test.ts

# каждый блок run: | по очереди — в add-to-project.yml их два
for wf in .github/workflows/*.yml; do
  n=1
  while awk -v n="$n" -f tests/extract-run.awk "$wf" > "$TMP/run.sh" && [ -s "$TMP/run.sh" ]; do
    shellcheck -s bash -S warning "$TMP/run.sh" || { echo "shellcheck: замечания в $wf, блок run №$n"; exit 1; }
    n=$((n + 1))
  done
done

# скрипты и тесты лежат файлами — проверяются как есть
shellcheck -s bash -S warning -x scripts/*.sh tests/*.sh

echo "lint ok"
