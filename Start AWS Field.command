#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null; then
  echo 'Install Node.js 22 or newer before starting AWS Field.' >&2
  exit 1
fi
export PORT="${PORT:-4187}"
./start.sh &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for attempt in {1..40}; do
  kill -0 "$server_pid" 2>/dev/null || { wait "$server_pid"; exit 1; }
  if curl -fsS "http://127.0.0.1:$PORT/api/workspace" >/dev/null; then
    open "http://127.0.0.1:$PORT/"
    wait "$server_pid"
    exit
  fi
  sleep 0.25
done
wait "$server_pid"
