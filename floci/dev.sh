#!/usr/bin/env bash
# floci/dev.sh -- one-command local dev launcher for the groov-db-api +
# groov-db-ui Floci stack.
#
# It builds + provisions the stack, waits until the UI has actually compiled,
# prints a ready-to-use summary (URLs, login, handy commands), then attaches
# `docker compose watch` so edits under groov-db-ui/src/ hot-reload and a
# package.json change rebuilds the image. Ctrl-C stops watching; the containers
# keep running (`docker compose down` to stop them).
#
# Run it from anywhere -- this cd's to the repo root first, because compose
# derives each Lambda's hot-reload host path (HOST_API_DIR=${PWD}) from the
# working directory, which must be the groov-db-api repo root.
#
# It then re-cd's to `pwd -P` to pin the working directory to its REAL on-disk
# case. This matters on case-INSENSITIVE filesystems (macOS; Windows too): you
# can `cd` into e.g. .../documents/... when the directory is really
# .../Documents/..., and $PWD silently keeps that wrong case. Docker Compose
# registers the `develop.watch` paths using $PWD, but the OS delivers
# file-change events under the canonical case, and Compose's event->trigger
# match is case-SENSITIVE. The mismatch makes `docker compose watch` PRINT
# "Syncing service ui after N changes were detected" while copying NOTHING into
# the container -- so UI edits appear to sync but never actually hot-reload.
# `pwd -P` returns the canonical case, so re-cd'ing there keeps watch working.
# (On Linux the filesystem is case-sensitive, so this is a harmless no-op
# beyond resolving any symlinks in the path.)
set -euo pipefail

cd "$(dirname "$0")/.."
cd "$(pwd -P)"
echo "▶ Working directory: $PWD"

UI_URL="http://localhost:3000"
AWS_URL="http://localhost:4566"
RULE="=================================================================="

echo "▶ Starting groovDB local dev (build + provision from template.yaml)…"
if ! docker compose up --build -d; then
  echo "✖ Stack failed to start. Inspect: docker compose logs floci-init" >&2
  exit 1
fi

# Wait (bounded) for the CRA dev server's first compile, so the banner means
# "actually ready to use", not merely "container started".
printf "▶ Waiting for the UI to compile"
for _ in $(seq 1 60); do
  if docker compose logs ui 2>/dev/null | grep -qiE "compiled successfully|webpack compiled"; then
    break
  fi
  printf "."
  sleep 2
done
echo

# The per-run API base is written by the provisioner into the shared volume;
# read it back through the ui container (which mounts /shared read-only).
API_BASE="$(docker compose exec -T ui sh -c 'cat /shared/ui.env 2>/dev/null' 2>/dev/null \
  | sed -n 's/^REACT_APP_API_BASE=//p')"
API_BASE="${API_BASE:-<not found — see: docker compose logs floci-init>}"

cat <<BANNER

${RULE}
  ✅  groovDB local dev is READY
${RULE}
  UI            ${UI_URL}
                  sign in as  admin@groov.local  /  GroovLocal1!
  API (V2)      ${API_BASE}
  AWS endpoint  ${AWS_URL}   (Floci: API GW · Lambda · Cognito · DynamoDB · S3)

  Live reload is ON:
    • edit  groov-db-ui/src/**        → the page Fast-Refreshes
    • edit  functions/**/*.py         → the Lambda hot-reloads on next call
    • change groov-db-ui/package.json → the UI image rebuilds

  Handy:
    bash floci/smoke.sh                            # 17-check auth + route smoke
    docker compose run --rm floci-init --reseed    # reset seeded data (keep the stack)
    docker compose logs -f ui                      # follow the UI dev server
    docker compose down                            # stop the stack (data kept)

  Watching for changes — press Ctrl-C to stop watching
  (containers stay up; run 'docker compose down' to stop them).
${RULE}

BANNER

# `compose watch` holds an exclusive per-project lock, and a watcher from an
# earlier run can outlive its terminal (orphaned to launchd) and keep the lock
# forever — the next run then fails with "cannot take exclusive lock". Stop any
# watcher that was started from this repo root before taking over.
for pid in $(pgrep -f "docker-compose compose watch" || true); do
  if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qx "n$PWD"; then
    echo "▶ Stopping stale compose watch (PID $pid) from a previous run…"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 25); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
  fi
done

exec docker compose watch --no-up
