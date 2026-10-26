#!/bin/sh
set -eu
chat_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$chat_dir"
./node_modules/.bin/tsc -p tsconfig.writer.json
./node_modules/.bin/tsc-alias -p tsconfig.writer.json
mkdir -p .local/writer-dist/proto
cp src/proto/identity.proto .local/writer-dist/proto/identity.proto
context=$(mktemp -d /private/tmp/tapik-writer-image.XXXXXX)
trap 'rm -rf "$context"' EXIT HUP INT TERM
cp package.json package-lock.json Dockerfile.writer "$context/"
cp -R .local/writer-dist "$context/writer-dist"
docker build -f "$context/Dockerfile.writer" -t tapik-message-writer:local "$context"
