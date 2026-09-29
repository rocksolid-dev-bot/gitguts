#!/usr/bin/env bash
# fresh-clone-check.sh — proves defect 1 stays fixed in a SECOND tree, not the
# one that generated the fixtures. Red direction (no pretest) must fail;
# green direction (with pretest) must pass. Asserted, not assumed.
set -u

status=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

echo "== clone =="
git clone -q "$repo_root" "$tmp_dir"
echo "clone exit=$?"

cd "$tmp_dir"

echo "== npm ci =="
npm ci >/dev/null 2>&1
npm_ci_exit=$?
echo "npm ci exit=$npm_ci_exit"

echo "== red direction: no pretest =="
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  delete pkg.scripts.pretest;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'
npx vitest run >/dev/null 2>&1
no_pretest_exit=$?
echo "no-pretest exit=$no_pretest_exit"
if [ "$no_pretest_exit" -eq 0 ]; then
  echo "FAIL: no-pretest run should be non-zero (fixtures should be missing) but exited 0"
  status=1
fi

echo "== green direction: with pretest =="
git checkout -- package.json
npm test >/dev/null 2>&1
with_pretest_exit=$?
echo "with-pretest exit=$with_pretest_exit"
if [ "$with_pretest_exit" -ne 0 ]; then
  echo "FAIL: with-pretest run should be zero but exited $with_pretest_exit"
  status=1
fi

echo "fresh-clone overall exit=$status"
exit "$status"
