# Печатает тело первого блока `run: |` из workflow без отступа YAML.
# Запуск: awk -f tests/extract-run.awk .github/workflows/telegram.yml
!found && /^[ ]*run: \|[ ]*$/ { found = 1; next }
found {
  if ($0 ~ /^[ ]*$/) { print ""; next }
  match($0, /^ */)
  if (!ind) ind = RLENGTH
  if (RLENGTH < ind) exit
  print substr($0, ind + 1)
}
