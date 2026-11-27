#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null || ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
  echo 'AWS Field requires Node.js 22 or newer.' >&2
  exit 1
fi
exec node server.mjs
