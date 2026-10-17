#!/bin/sh
set -eu
chat_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
private_dir="$chat_dir/.local/epic04"
container=tapik-message-writer
case "${1:-status}" in
  start)
    if docker container inspect "$container" >/dev/null 2>&1; then
      exec docker start "$container"
    fi
    for file in writer.env tls.crt tls.key; do
      if [ ! -f "$private_dir/$file" ]; then
        echo "Missing private writer file: $file" >&2
        exit 1
      fi
    done
    exec docker run -d \
      --name "$container" \
      --restart unless-stopped \
      --network chat-alpha-network \
      --env-file "$private_dir/writer.env" \
      -p 127.0.0.1:3009:3009 \
      --mount "type=bind,source=$private_dir/tls.crt,target=/run/writer/tls.crt,readonly" \
      --mount "type=bind,source=$private_dir/tls.key,target=/run/writer/tls.key,readonly" \
      --read-only --tmpfs /tmp --cap-drop ALL \
      --security-opt no-new-privileges:true \
      tapik-message-writer:local
    ;;
  stop) exec docker stop "$container" ;;
  status) exec docker ps -a --filter "name=^/$container$" --format '{{.Names}}: {{.Status}} {{.Ports}}' ;;
  logs) exec docker logs --tail 50 "$container" ;;
  *) echo 'Usage: scripts/epic04-runtime.sh [start|stop|status|logs]' >&2; exit 2 ;;
esac
