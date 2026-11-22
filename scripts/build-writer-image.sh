#!/bin/sh
set -eu
chat_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$chat_dir"
context=$(mktemp -d /private/tmp/tapik-writer-image.XXXXXX)
trap 'rm -rf "$context"' EXIT HUP INT TERM
cp package.json package-lock.json Dockerfile.writer "$context/"
output="$context/writer-dist"
./node_modules/.bin/tsc -p tsconfig.writer.json --outDir "$output"
./node_modules/.bin/tsc-alias -p tsconfig.writer.json --outDir "$output"
mkdir -p "$output/proto"
cp src/proto/identity.proto "$output/proto/identity.proto"
docker build -f "$context/Dockerfile.writer" -t tapik-message-writer:local "$context"
