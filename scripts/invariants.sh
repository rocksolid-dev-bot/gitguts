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

# Scoped to *.ts: unscoped, "void " also matches the word "avoid" inside the
# generated fixture repos' pre-commit.sample hooks, which are not code this
# project wrote and can never go green. src/ is covered by noUnusedLocals and
# has legitimate uses of void; this guard exists for test/ only, which
# tsconfig's "include": ["src"] never reaches.
if [ -z "$(grep -rn --include=*.ts "void " test/)" ]; then
  echo "ok: no void in test/"
else
  echo "FAIL: void found in test/"
  status=1
fi

exit $status
