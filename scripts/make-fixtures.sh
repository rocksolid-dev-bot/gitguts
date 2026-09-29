#!/usr/bin/env bash
# Builds a deterministic fixture repo under test/fixtures/repos/basic/
# by invoking git itself. Never hand-shape fixture objects.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$ROOT/test/fixtures/repos/basic"

rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"
cd "$FIXTURE_DIR"

git init -q
git config user.name "gitguts-fixture"
git config user.email "gitguts-fixture@example.com"

echo "hello" > f.txt
git add f.txt

export GIT_AUTHOR_DATE="2026-01-01T00:00:00+00:00"
export GIT_COMMITTER_DATE="2026-01-01T00:00:00+00:00"
git commit -q -m "initial"

echo "ok: fixture repo built at $FIXTURE_DIR"
