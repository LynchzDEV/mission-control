#!/bin/sh
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then
    prompt="$arg"
    break
  fi
  prev="$arg"
done
name=$(printf '%s\n' "$prompt" | sed -n 's/.*fixture:\([a-z][a-z]*\).*/\1/p' | head -n 1)
case "$name" in
  tools | failed | slow) ;;
  *) name=tools ;;
esac
fixture="$(dirname "$0")/../test/fixtures/chat/$name.jsonl"
if [ "$name" = slow ]; then
  head -n 4 "$fixture"
  sleep 60
  tail -n +5 "$fixture"
else
  cat "$fixture"
fi
