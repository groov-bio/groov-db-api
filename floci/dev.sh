#!/usr/bin/env bash
# floci/dev.sh -- one-command local dev launcher for the groov-db-api +
# groov-db-ui Floci stack.
#
# It builds + provisions the stack, waits until the UI has actually compiled,
# prints a ready-to-use summary (URLs, login, handy commands), then watches
# for file changes so edits under groov-db-ui/src/ hot-reload and a
# package.json change rebuilds the image.
#
# By default the watcher runs in the FOREGROUND (Ctrl-C stops watching; the
# containers keep running). Pass --detach to background the watcher and get the
# terminal back. See --help for all flags.
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

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
DETACH=0
NO_BUILD=0
# Empty => the UI shim's default identity (admin@groov.local). A non-empty
# value is exported as GROOV_LOCAL_AUTH_USER and interpolated by
# docker-compose.yml into the ui service's REACT_APP_LOCAL_AUTH_USER.
AUTH_USER=""

usage() {
  cat <<'USAGE'
dev.sh -- one-command local dev launcher for the groov-db-api + groov-db-ui
Floci stack. Builds + provisions the stack from template.yaml, waits until the
UI has compiled, prints a ready-to-use summary, then watches for file changes
so edits hot-reload.

Usage:
  bash floci/dev.sh [options]

Options:
  -d, --detach        Run the file watcher in the BACKGROUND and return the
                      terminal, instead of holding it in the foreground. The
                      stack itself always runs detached; this only affects the
                      watcher. Its output goes to ./.floci-watch.log. Stop it
                      with `docker compose down` or by re-running dev.sh.
      --user[=EMAIL]  Sign the UI in as the seeded NON-admin user
                      (user@groov.local) instead of the admin. Pass an explicit
                      seeded email with --user=EMAIL. Default (no flag): admin.
      --admin         Sign in as the seeded admin (admin@groov.local). This is
                      the default; the flag is here for explicitness/symmetry.
      --no-build      Skip forcing an image rebuild (faster restart when
                      neither a Dockerfile nor package.json changed).
  -h, --help          Show this help and exit.

Seeded users (both password GroovLocal1!):
  admin@groov.local   group "Admin" -- full admin UI (add/edit/delete/approve)
  user@groov.local    no group      -- regular non-admin experience

In the UI you don't type these: clicking "Sign in" auto-authenticates as the
selected identity (no password prompt) via the local-auth shim.

Examples:
  bash floci/dev.sh                 # admin, watcher in foreground
  bash floci/dev.sh --detach        # admin, watcher backgrounded
  bash floci/dev.sh --user          # sign in as user@groov.local
  bash floci/dev.sh --user -d       # non-admin + detached
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--detach) DETACH=1 ;;
    --no-build)  NO_BUILD=1 ;;
    --admin)     AUTH_USER="admin@groov.local" ;;
    --user)      AUTH_USER="user@groov.local" ;;
    --user=*)    AUTH_USER="${1#--user=}" ;;
    -h|--help)   usage; exit 0 ;;
    *)
      echo "✖ Unknown option: $1" >&2
      echo "  Try: bash floci/dev.sh --help" >&2
      exit 2
      ;;
  esac
  shift
done

# Exported so docker-compose.yml interpolates it into the ui service's
# REACT_APP_LOCAL_AUTH_USER. Empty => the UI shim's default (admin@groov.local).
export GROOV_LOCAL_AUTH_USER="${AUTH_USER}"
SIGNIN_USER="${AUTH_USER:-admin@groov.local}"
if [[ "$SIGNIN_USER" == "admin@groov.local" ]]; then
  SIGNIN_NOTE="admin@groov.local  /  GroovLocal1!   (group: Admin)"
else
  SIGNIN_NOTE="${SIGNIN_USER}  /  GroovLocal1!   (non-admin)"
fi

cd "$(dirname "$0")/.."
cd "$(pwd -P)"
echo "▶ Working directory: $PWD"

UI_URL="http://localhost:3000"
AWS_URL="http://localhost:4566"
RULE="=================================================================="
WATCH_LOG="$PWD/.floci-watch.log"

echo "▶ Starting groovDB local dev (build + provision from template.yaml)…"
echo "▶ UI will sign in as: ${SIGNIN_USER}"
UP_ARGS=(up -d)
if [[ "$NO_BUILD" -eq 0 ]]; then
  UP_ARGS+=(--build)
fi
if ! docker compose "${UP_ARGS[@]}"; then
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
                  sign in as  ${SIGNIN_NOTE}
                  (just click "Sign in" — no password prompt)
  API (V2)      ${API_BASE}
  AWS endpoint  ${AWS_URL}   (Floci: API GW · Lambda · Cognito · DynamoDB · S3)

  Live reload is ON:
    • edit  groov-db-ui/src/**        → the page Fast-Refreshes
    • edit  functions/**/*.py         → the Lambda hot-reloads on next call
    • change groov-db-ui/package.json → the UI image rebuilds

  Handy:
    bash floci/dev.sh --help                       # all flags (detach, user, …)
    bash floci/smoke.sh                            # 17-check auth + route smoke
    docker compose run --rm floci-init --reseed    # reset seeded data (keep the stack)
    docker compose logs -f ui                      # follow the UI dev server
    docker compose down                            # stop the stack (data kept)
${RULE}

BANNER

# `docker compose watch` holds an exclusive per-project lock, and a watcher from
# an earlier run can outlive its terminal (a `--detach`, or a closed terminal)
# and keep the lock — the next run then fails with "cannot take exclusive lock
# for project ... PID N is still running". Crucially it runs as TWO processes:
# the `docker compose watch` parent AND a cli-plugin child (`.../docker-compose
# compose watch`) that actually holds the lock. BOTH must die — killing only one
# leaves the lock held (this is what the earlier one-process-only cleanup missed).
#
# Find every `compose watch` process rooted in THIS repo (cwd == $PWD, so we
# never touch another project's watcher), SIGTERM them, then SIGKILL any that
# don't exit within ~5s. Re-scan each pass so parent+child are both reaped.
_stale_watch_pids() {
  local pid cwd
  for pid in $(pgrep -f "compose watch" 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1)"
    [ "$cwd" = "$PWD" ] && printf '%s ' "$pid"
  done
}

# Poll until no stale watcher remains, up to $1 iterations of 0.2s. Waiting for
# the processes to actually EXIT matters: a Docker CLI process can linger a few
# seconds after a signal (it's blocked on the Docker socket), and Compose treats
# the lock as held until the recorded PID is truly gone — so proceeding the
# instant we *send* a signal is exactly what left the lock stuck before.
_wait_watch_gone() {
  local i=0
  while [ -n "$(_stale_watch_pids)" ]; do
    i=$((i + 1))
    [ "$i" -ge "$1" ] && return 1
    sleep 0.2
  done
  return 0
}

stale="$(_stale_watch_pids)"
if [ -n "$stale" ]; then
  echo "▶ Stopping stale 'compose watch' from a previous run (PIDs: ${stale})…"
  # shellcheck disable=SC2086
  kill -TERM $stale 2>/dev/null || true
  if ! _wait_watch_gone 25; then          # ~5s for a graceful shutdown
    stale="$(_stale_watch_pids)"
    echo "▶ Escalating to SIGKILL (PIDs: ${stale})…"
    # shellcheck disable=SC2086
    kill -KILL $stale 2>/dev/null || true
    _wait_watch_gone 75 || true           # ~15s: procs can linger post-SIGKILL;
                                          # the lock frees only once they're gone
  fi
  if [ -n "$(_stale_watch_pids)" ]; then
    echo "✖ Could not stop a stale watcher — the compose lock may still be held." >&2
    echo "  Free it manually and re-run:  pkill -9 -f 'compose watch'" >&2
    exit 1
  fi
  echo "▶ Stale watcher stopped; lock released."
fi

if [[ "$DETACH" -eq 1 ]]; then
  # No native `--detach` on `compose watch` (v2.31), so background it ourselves.
  # nohup + disown so it survives this script exiting and the terminal closing.
  : > "$WATCH_LOG"
  nohup docker compose watch --no-up >"$WATCH_LOG" 2>&1 &
  WATCH_PID=$!
  disown 2>/dev/null || true
  cat <<DETACHED
▶ File watcher running in the background (PID ${WATCH_PID}).
    logs:  tail -f ${WATCH_LOG}
    stop:  docker compose down     (or just re-run: bash floci/dev.sh)
  Terminal is yours — the stack and hot-reload keep running.
DETACHED
  exit 0
fi

echo "  Watching for changes — press Ctrl-C to stop watching"
echo "  (containers stay up; run 'docker compose down' to stop them)."
exec docker compose watch --no-up
