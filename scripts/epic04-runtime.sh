#!/bin/sh
set -eu
chat_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$chat_dir/.local/epic04/compose.yml"
if [ ! -f "$compose_file" ]; then
  echo 'Private deployment configuration is missing: .local/epic04/compose.yml' >&2
  exit 1
fi
case "${1:-status}" in
  start) exec docker compose --env-file /dev/null -f "$compose_file" up -d ;;
  stop) exec docker compose --env-file /dev/null -f "$compose_file" stop ;;
  status) exec docker compose --env-file /dev/null -f "$compose_file" ps ;;
  logs) exec docker compose --env-file /dev/null -f "$compose_file" logs --tail 50 ;;
  *) echo 'Usage: scripts/epic04-runtime.sh [start|stop|status|logs]' >&2; exit 2 ;;
esac
