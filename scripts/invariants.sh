#!/usr/bin/env bash
# Committed invariants, run from the close-out capture and CI-equivalent gates.
# Each check prints ok:/FAIL: and can flip the exit status.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

status=0

if [ -z "$(grep -rn "child_process\|execSync" src/)" ]; then
  echo "ok: no child_process/execSync in src/"
else
  echo "FAIL: child_process/execSync found in src/"
  status=1
fi

if [ -z "$(grep -rn "throw " src/)" ]; then
  echo "ok: no throw in src/"
else
  echo "FAIL: throw found in src/"
  status=1
fi

exit $status
