# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
- Fixture generation (`scripts/make-fixtures.sh`) that builds both the loose
  and packed test repositories by invoking `git` directly, with pinned author
  and committer dates for determinism.
- Pack delta reconstruction (`src/pack.ts`): parses `OFS_DELTA`/`REF_DELTA`
  object headers and their copy/insert instruction streams, then resolves a
  delta chain to its final object bytes. Verified in
  `test/pack-oracle.test.ts`, which reconstructs all twelve objects in the
  packed fixture byte-identically against `git cat-file`.
