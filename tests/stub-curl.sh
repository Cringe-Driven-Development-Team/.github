#!/usr/bin/env bash
# Заглушка curl для тестов: вместо отправки в Telegram сохраняет сообщение
# в $SENT/<номер> — строка topic=<message_thread_id>, строка markup=<reply_markup>, дальше текст.
topic=""
markup=""
text=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) case "$2" in message_thread_id=*) topic=${2#message_thread_id=} ;; esac; shift 2 ;;
    --data-urlencode)
      case "$2" in
        text=*) text=${2#text=} ;;
        reply_markup=*) markup=${2#reply_markup=} ;;
      esac
      shift 2 ;;
    *) shift ;;
  esac
done
n=$(( $(find "$SENT" -type f | wc -l) + 1 ))
printf 'topic=%s\nmarkup=%s\n%s' "$topic" "$markup" "$text" > "$SENT/$n"
echo '{"ok":true}'
