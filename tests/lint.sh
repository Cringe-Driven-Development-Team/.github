#!/usr/bin/env bash
# Проверяет все workflow: actionlint — YAML и выражения, shellcheck — скрипты из run: |.
# Встроенный в actionlint вызов shellcheck на Windows зависает, поэтому он запускается отдельно.
# Нужны actionlint, shellcheck и awk. Запуск: bash tests/lint.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

actionlint -no-color -oneline -shellcheck= -pyflakes=

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
