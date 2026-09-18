#!/usr/bin/env bash
# Заглушка curl для тестов: вместо отправки в Telegram сохраняет сообщение
# в $SENT/<номер> — первая строка topic=<message_thread_id>, дальше текст.
topic=""
text=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) case "$2" in message_thread_id=*) topic=${2#message_thread_id=} ;; esac; shift 2 ;;
    --data-urlencode) case "$2" in text=*) text=${2#text=} ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
n=$(( $(find "$SENT" -type f | wc -l) + 1 ))
printf 'topic=%s\n%s' "$topic" "$text" > "$SENT/$n"
echo '{"ok":true}'
