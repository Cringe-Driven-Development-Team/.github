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

for wf in .github/workflows/*.yml; do
  awk -f tests/extract-run.awk "$wf" > "$TMP/run.sh"
  [ -s "$TMP/run.sh" ] || continue
  shellcheck -s bash -S warning "$TMP/run.sh" || { echo "shellcheck: замечания в $wf"; exit 1; }
done

# скрипты и тесты лежат файлами — проверяются как есть
shellcheck -s bash -S warning -x scripts/*.sh tests/*.sh

echo "lint ok"
