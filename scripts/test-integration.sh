#!/usr/bin/env bash
# Local integration-test runner.
#
# Boots a Postgres service via docker compose, applies cortextos migrations,
# runs the DB-backed vitest suites against it, then tears the container down.
#
# Used by `npm run test:integration`. CI (.github/workflows/ci.yml ::
# integration-tests) uses a GH Actions postgres service container against
# the same migrations — this script is the local-parity surface so devs can
# debug integration failures without pushing to CI.
#
# Why a script and not "docker compose run --rm app vitest":
#   The vitest binary lives in repo node_modules and needs to talk to the
#   compose-hosted Postgres on the host network (port 54330). Running vitest
#   on the host keeps the dev's existing node_modules / package-lock / tsx
#   path resolution intact; the container just hosts the DB.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.test.yml"
DB_URL="postgres://postgres:postgres@localhost:54330/postgres"

cleanup() {
  echo "==> Tearing down Postgres"
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Booting Postgres (compose)"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for Postgres health"
for i in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    echo "    healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Postgres did not become healthy in 30s" >&2
    docker compose -f "$COMPOSE_FILE" logs postgres >&2
    exit 1
  fi
  sleep 1
done

echo "==> Applying migrations (0001-0003)"
for m in supabase/migrations/0001_*.sql supabase/migrations/0002_*.sql supabase/migrations/0003_*.sql; do
  echo "    $(basename "$m")"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$m" >/dev/null
done

echo "==> Running DB-backed integration tests"
SUPABASE_GBRAIN_DATABASE_URL="$DB_URL" \
  npx vitest run \
    tests/integration/spawn-lease.test.ts \
    tests/integration/daemon-spawn-lease-cross-process.test.ts

echo "==> Done"
