#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
container=$(docker run --rm -d -p 127.0.0.1::9042 scylladb/scylla:5.4 --smp 1 --memory 750M --overprovisioned 1)
trap 'docker stop "$container" >/dev/null' EXIT
attempt=0
until docker exec "$container" cqlsh -e 'SELECT release_version FROM system.local' >/dev/null 2>&1; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 90 ]; then exit 1; fi
  sleep 1
done
docker exec -i "$container" cqlsh < test/integration/schema.cql
port=$(docker port "$container" 9042/tcp | cut -d: -f2)
SCYLLA_CONTACT_POINT=127.0.0.1 SCYLLA_PORT="$port" SCYLLA_KEYSPACE=epic1_test SCYLLA_USERNAME=test SCYLLA_PASSWORD=test \
  node -r ts-node/register/transpile-only -r tsconfig-paths/register test/integration/group-admission.cjs
