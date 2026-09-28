# Печатает тело n-го блока `run: |` из workflow (по умолчанию первого) без отступа YAML.
# Блока нет — пустой вывод.
# Запуск: awk [-v n=2] -f tests/extract-run.awk .github/workflows/telegram.yml
BEGIN { if (n == "") n = 1 }
!found && /^[ ]*run: \|[ ]*$/ { if (++seen == n) found = 1; next }
found {
  if ($0 ~ /^[ ]*$/) { print ""; next }
  match($0, /^ */)
  if (!ind) ind = RLENGTH
  if (RLENGTH < ind) exit
  print substr($0, ind + 1)
}
