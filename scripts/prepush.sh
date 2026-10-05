#!/usr/bin/env bash
# Pre-push gate. Deliberately does not use `set -e`: every step prints its own
# exit code and the script accumulates `status`, so one failure never hides
# the steps that come after it.

status=0

echo "--- 1: node -v ---"
node -v
rc=$?; echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 2: npm ci ---"
npm ci
rc=$?; echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 3: npx tsc --noEmit ---"
npx tsc --noEmit
rc=$?; echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 4: npm run build ---"
npm run build
rc=$?; echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 5: npm test ---"
npm test 2>&1 | tee /tmp/gg-test-output.txt
rc=${PIPESTATUS[0]}
cat /tmp/gg-test-output.txt
echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 6: bash scripts/invariants.sh ---"
bash scripts/invariants.sh
rc=$?; echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 7: orphan guard (tsconfig.orphan.json) ---"
cat > tsconfig.orphan.json <<'EOF'
{
  "extends": "./tsconfig.json",
  "include": ["src", "test"],
  "compilerOptions": {
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
EOF
npx tsc --noEmit -p tsconfig.orphan.json
rc=$?
rm -f tsconfig.orphan.json
echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 8: npm pack --dry-run assertions ---"
packtmp=$(mktemp)
npm pack --dry-run 2>"$packtmp" >/dev/null
src_count=$(grep -c " src/" "$packtmp")
test_count=$(grep -c " test/" "$packtmp")
media_count=$(grep -c " media/" "$packtmp")
dist_count=$(grep -c " dist/" "$packtmp")
filename_line=$(grep "filename:" "$packtmp")
pkg_name=$(node -p "require('./package.json').name")
pkg_version=$(node -p "require('./package.json').version")
expected_tgz="$pkg_name-$pkg_version.tgz"
dist_actual=$(find dist -type f | wc -l)
echo "src_count=$src_count test_count=$test_count media_count=$media_count"
echo "dist_pack=$dist_count dist_actual=$dist_actual expected=$expected_tgz"
echo "$filename_line"
rc=0
[ "$src_count" -ne 0 ] && rc=1
[ "$test_count" -ne 0 ] && rc=1
[ "$media_count" -ne 0 ] && rc=1
[ "$dist_count" -eq "$dist_actual" ] || rc=1
[ "$dist_actual" -ne 0 ] || rc=1
case "$filename_line" in
  *"$expected_tgz"*) ;;
  *) rc=1 ;;
esac
rm -f "$packtmp"
echo "exit=$rc"; [ "$rc" -ne 0 ] && status=1

echo "--- 9: node dist/cli.js test/fixtures/repos/basic ---"
out9=$(node dist/cli.js test/fixtures/repos/basic)
rc=$?
echo "$out9"
nan_count=$(echo "$out9" | grep -c NaN)
echo "nan_count=$nan_count"
echo "exit=$rc"
[ "$rc" -ne 0 ] && status=1
[ "$nan_count" -ne 0 ] && status=1

echo "--- 10: node dist/cli.js /tmp/definitely-not-a-repo ---"
node dist/cli.js /tmp/definitely-not-a-repo
rc=$?
echo "exit=$rc"
[ "$rc" -eq 0 ] && status=1

echo "--- 11: overall ---"
echo "overall exit=$status"
exit $status
