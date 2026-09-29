# gitguts

Open a repository's .git and explain it: how many objects are loose vs packed, what the delta chains look like, which blobs actually dominate the pack, and what git gc bought you.

## Status

Day 2. Two readers so far:

- `readLooseObject` (`src/loose.ts`) — inflates and parses a single loose
  object (`.git/objects/xx/yyyy...`): type, size, raw payload.
- `readIdx` / `lookupBySha` (`src/idx.ts`) — parses a pack `.idx` v2 file
  (magic, version, 256-entry fanout, sorted SHA/CRC/offset tables) and
  looks up an object's pack offset by SHA. Both are read-only, return a
  value on failure rather than throwing, and are verified against
  `git verify-pack -v` as the oracle in `test/`.

## Limitations

- **64-bit offset overflow is unproven.** `.idx` v2 supports packs whose
  objects sit past the 2 GB boundary via an 8-byte overflow table indexed
  by the top bit of the 4-byte offset. `readIdx` implements that branch,
  but no fixture this project generates produces a pack anywhere near that
  size, so the branch is written and typed but exercised by nothing. Treat
  it as unverified until a fixture (or a real large repo) reaches it.
- `.idx` v1 is out of scope; only v2 is read.
