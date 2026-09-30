# gitguts

Open a repository's .git and explain it: how many objects are loose vs packed, what the delta chains look like, which blobs actually dominate the pack, and what git gc bought you.

## Status

Day 3. Three readers so far:

- `readLooseObject` (`src/loose.ts`) — inflates and parses a single loose
  object (`.git/objects/xx/yyyy...`): type, size, raw payload.
- `readIdx` / `lookupBySha` (`src/idx.ts`) — parses a pack `.idx` v2 file
  (magic, version, 256-entry fanout, sorted SHA/CRC/offset tables) and
  looks up an object's pack offset by SHA.
- `readPackObjectHeader` / `parseDeltaStream` / `applyDelta` /
  `resolvePackObject` (`src/pack.ts`) — reads a pack object header at a
  given offset, resolves an `OFS_DELTA` base offset or `REF_DELTA` base
  SHA, parses a delta stream's copy/insert instructions, and reconstructs
  a delta chain's full bytes recursively, reporting the chain depth
  walked.

All three are read-only, return a value on failure rather than throwing,
and are verified against `git verify-pack -v` / `git cat-file` as the
oracle in `test/`.

## Limitations

- **64-bit offset overflow is unproven.** `.idx` v2 supports packs whose
  objects sit past the 2 GB boundary via an 8-byte overflow table indexed
  by the top bit of the 4-byte offset. `readIdx` implements that branch,
  but no fixture this project generates produces a pack anywhere near that
  size, so the branch is written and typed but exercised by nothing. Treat
  it as unverified until a fixture (or a real large repo) reaches it.
- **`REF_DELTA` is written and unproven.** `resolvePackObject` resolves a
  `REF_DELTA` base via a caller-supplied SHA lookup, but no fixture this
  project generates emits a `REF_DELTA` object — even
  `git -c pack.useDeltaBaseOffset=false repack -adq` on this fixture still
  produces `OFS_DELTA` throughout (a byte-identical pack, in fact). Treat
  the `REF_DELTA` path as unverified until a fixture reaches it.
- `.idx` v1 is out of scope; only v2 is read.
