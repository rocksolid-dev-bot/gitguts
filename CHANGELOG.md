# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-10-05

### Changed

- The published package now ships only `dist/`, `README.md`, `LICENSE` and
  `CHANGELOG.md`. Earlier tarballs also carried the TypeScript sources, the
  test suite, `tsconfig.json` and the `media/` build captures.
- CLI output: the `largest blobs` ranking label is renamed to
  `largest objects`, matching `largestObjects`'s actual behavior of ranking
  every object type (commit/tree/blob), not blobs alone. The loose-objects
  line and the ranking block now both name their byte unit explicitly: the
  loose-objects total is on-disk (compressed) bytes, while each ranked
  object's size is its logical (uncompressed) byte count -- the two had
  shared one unlabeled number before this change.

### Added

- Loose-object reader (`src/loose.ts`): parses the zlib-compressed
  `<type> <SP> <len> <NUL> <payload>` framing used by `.git/objects/<xx>/<rest>`,
  with an oracle test suite (`test/oracle.test.ts`) that byte-checks every
  reconstructed object against `git cat-file -t/-s/--batch`.
- Packfile `.idx` v2 reader (`src/idx.ts`): parses the magic, version, fanout
  table, sorted SHA-1 table, CRC32 table and offset table (including the
  64-bit large-offset table, written but unexercised by current fixtures), and
  exposes `lookupBySha` via binary search. Verified against `git verify-pack -v`
  in `test/idx-oracle.test.ts`.
- Fixture generation (`scripts/make-fixtures.sh`) that builds three test
  repositories by invoking `git` directly, with pinned author and committer
  dates for determinism: `basic` and `packed` (loose and packed object
  storage), and `nested`, the loose fixture with a subdirectory so path
  resolution through tree objects has something real to resolve.
- Pack delta reconstruction (`src/pack.ts`): parses `OFS_DELTA`/`REF_DELTA`
  object headers and their copy/insert instruction streams, then resolves a
  delta chain to its final object bytes. Verified in
  `test/pack-oracle.test.ts`, which reconstructs all twelve objects in the
  packed fixture byte-identically against `git cat-file`.
- Tree reader (`src/tree.ts`): `parseTree` parses `<mode> <SP> <name> <NUL>
  <20-byte SHA>` entries out of a raw tree object, and `walkTree` resolves
  them recursively into a path→SHA map. Verified in `test/tree-oracle.test.ts`
  against `git ls-tree -r HEAD`.
- Repo invariants (`scripts/invariants.sh`): guards against `throw ` appearing
  in `src/` and `void ` appearing in `test/` (scoped `--include=*.ts`), so the
  no-throw and no-void-return conventions are checked, not just stated.
- `makeTreeLoader` (`src/store.ts`): a `load(sha)` callback for `walkTree`
  that resolves a tree SHA loose-first, then through any pack under
  `.git/objects/pack/` (via `idx.ts` + `pack.ts`), so tree walking works
  against a real repo where most trees are packed, not just the loose-only
  fixtures. Verified in `test/store-oracle.test.ts` against the `packed`
  fixture, where `walkTree`'s path→SHA map is set-compared against
  `git ls-tree -r HEAD` and the test also asserts the root tree has no loose
  object on disk, so the packed resolution path is proven taken, not merely
  available.
- Storage census (`src/summary.ts`): `storageCensus(gitDir)` counts loose
  and packed objects by matching the *shape* of a loose object path
  (`<2 hex>/<38 hex>` under `objects/`) rather than merely excluding
  `pack/`, so `objects/info/packs` is never miscounted as a loose object.
  Verified in `test/summary-oracle.test.ts` against `git count-objects -v`,
  parsed live, across all three fixtures.
- Delta-chain histogram (`src/summary.ts`): `deltaStats(gitDir)` resolves
  every object in every pack under `.git/objects/pack/` through
  `resolvePackObject` and buckets it by chain depth, reporting `histogram`,
  `maxDepth`, `meanDepth` (over all objects, not just the deltified subset)
  and `objects`. Keyed on "zero `.idx` files found" rather than on the
  `pack/` directory's existence, since `basic` and `nested` both have an
  empty one. Verified in `test/summary-oracle.test.ts` against
  `git verify-pack -v`, parsed live, including the degenerate pack-less
  case asserting `meanDepth` is `0`, never `NaN`.
- Largest objects by true size (`src/summary.ts`): `largestObjects(repoDir,
  n)` ranks every loose and packed object by reconstructed size (never a
  pack's stored delta-stream length), ties broken SHA-ascending, and
  resolves each object's path by walking HEAD's tree through
  `makeTreeLoader` -- `null` for anything not reachable from HEAD rather
  than a guess. Verified in `test/largest-objects-oracle.test.ts` against
  `git cat-file -s` / `git ls-tree -r HEAD`, including the packed fixture's
  four-way 3510-byte tie, where only one of the four resolves to a path.
- CLI entry point (`src/cli.ts`): a `"bin": gitguts` command that ties
  `loose.ts`/`idx.ts`/`pack.ts`/`tree.ts`/`summary.ts` together, printing a
  repo's storage census, delta-chain histogram and largest-objects ranking.
  Verified in `test/cli-oracle.test.ts` against live `git count-objects -v`.
