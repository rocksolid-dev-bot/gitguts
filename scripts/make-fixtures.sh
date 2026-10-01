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

# --- packed/ fixture -------------------------------------------------------
# Four commits over a 400-line file, 3 lines edited each time. This shape
# produces deltas (non delta: 9, chain length = 1: 3) because most of the
# file is unchanged between commits. Regenerating the file from scratch each
# time (rather than editing the working copy in place) is deliberate: an
# in-place `sed` on an already-edited file matches its own prior edits on
# later passes and can silently collapse four commits into one while every
# `git commit` still exits 0.
PACKED_DIR="$ROOT/test/fixtures/repos/packed"

rm -rf "$PACKED_DIR"
mkdir -p "$PACKED_DIR"
cd "$PACKED_DIR"

git init -q
git config user.name "gitguts-fixture"
git config user.email "gitguts-fixture@example.com"

for i in 1 2 3 4; do
  seq 1 400 | sed 's/^/line /' > big.txt
  sed -i \
    -e "10s/.*/line 10 edit${i}/" \
    -e "200s/.*/line 200 edit${i}/" \
    -e "390s/.*/line 390 edit${i}/" \
    big.txt
  git add big.txt
  export GIT_AUTHOR_DATE="2026-01-0${i}T00:00:00+00:00"
  export GIT_COMMITTER_DATE="2026-01-0${i}T00:00:00+00:00"
  git commit -q -m "edit ${i}"
done

git repack -adq

echo "ok: packed fixture repo built at $PACKED_DIR"

# --- nested/ fixture -------------------------------------------------------
# gitguts' headline is "largest blobs with their paths", and paths come from
# tree objects. Neither basic/ nor packed/ has a subdirectory, so a tree test
# against them would assert depth 1 and call it path resolution. This repo
# stays loose by design -- packed is the delta fixture, nested is the tree
# fixture.
NESTED_DIR="$ROOT/test/fixtures/repos/nested"

rm -rf "$NESTED_DIR"
mkdir -p "$NESTED_DIR"
cd "$NESTED_DIR"

git init -q
git config user.name "gitguts-fixture"
git config user.email "gitguts-fixture@example.com"

echo "top" > top.txt
mkdir -p src/deep
echo "deep" > src/deep/x.txt
git add top.txt src/deep/x.txt

export GIT_AUTHOR_DATE="2026-01-01T00:00:00+00:00"
export GIT_COMMITTER_DATE="2026-01-01T00:00:00+00:00"
git commit -q -m "nested"

echo "ok: nested fixture repo built at $NESTED_DIR"
