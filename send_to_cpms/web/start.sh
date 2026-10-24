#!/usr/bin/env bash
# Start the CPMS test app (EMO / CL6 registration flows + preference centre) and open it.
#
# Usage (from anywhere):  ./send_to_cpms/web/start.sh
#
# - installs dependencies on first run
# - stops anything already listening on port 8600 (e.g. yesterday's server)
# - starts the app and opens http://localhost:8600 in the browser
# The AWS side (bus, queues, Lambdas, state machine) is already deployed and needs no
# start-up; the app only needs the repo-root .env.prod for credentials.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"
PORT=8600
URL="http://localhost:${PORT}"

if [[ ! -f "${REPO_ROOT}/.env.prod" ]]; then
  echo "Missing ${REPO_ROOT}/.env.prod (AWS credentials + AWS_BUCKET_NAME) — the app can't reach AWS without it." >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  echo "Installing dependencies..."
  npm --prefix "${APP_DIR}" install --silent
fi

if pids="$(lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null)" && [[ -n "$pids" ]]; then
  echo "Stopping what's already on port ${PORT}..."
  kill $pids
  sleep 1
fi

# open the browser once the server answers
( for _ in $(seq 1 40); do
    if curl -s -o /dev/null "${URL}"; then open "${URL}" 2>/dev/null || true; exit 0; fi
    sleep 0.3
  done ) &

echo "Starting the app at ${URL} (Ctrl+C to stop)..."
exec npm --prefix "${APP_DIR}" start
