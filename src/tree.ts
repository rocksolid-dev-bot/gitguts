// Reader for git tree objects (see Documentation/gitformat-pack.txt and the
// tree object format it references). Read-only: never writes, never runs
// `git` as a subprocess — that stays in `test/` as the oracle.
//
// A tree object's inflated payload is a flat sequence of entries, each:
//
//   <mode> <SP> <name> <NUL> <20 raw bytes of SHA-1>
//
// The mode is printed as ASCII digits with no leading zero: a directory's
// raw mode is `40000`, five characters, not the six-character `040000` that
// `git ls-tree` prints. The two spellings are easy to conflate, and a mode
// comparison against the `ls-tree` column is red against correct code
// unless exactly one side normalises — this parser returns the raw string
// exactly as the bytes spell it; normalising for display or comparison is
// the test's job, not this one's.
//
// The SHA is the raw 20 bytes, not hex — distinct from every other SHA this
// project handles elsewhere as a 40-character hex string. It is hex-encoded
// here before being returned, so every other module sees the same shape it
// already expects.

import type { PackError } from "./pack.js";

export type TreeEntryKind = "tree" | "blob";

export interface TreeEntry {
  /** Raw mode string exactly as the bytes spell it, e.g. "40000" (five
   * characters, no leading zero) for a directory, "100644" for a regular
   * file. Never normalised or zero-padded here. */
  mode: string;
  name: string;
  /** Lowercase hex SHA-1, decoded from the 20 raw bytes in the object. */
  sha: string;
  /** Derived from `mode`: "40000" is a tree, everything else observed in
   * practice (100644, 100755, 120000, 160000) is treated as a blob for this
   * project's purposes — gitguts does not yet distinguish symlinks or
   * gitlinks from regular blobs. */
  kind: TreeEntryKind;
}

const MODE_TREE = "40000";
const SHA_BYTES = 20;

/**
 * Parses a single tree object's inflated payload into its flat entry list.
 * Does not recurse into subtrees — see `walkTree` in this module's sibling
 * for that. A corrupt or truncated payload is a returned error, never a
 * throw.
 */
export function parseTree(payload: Uint8Array): TreeEntry[] | PackError {
  const entries: TreeEntry[] = [];
  let pos = 0;

  while (pos < payload.length) {
    const spaceIndex = payload.indexOf(0x20, pos);
    if (spaceIndex === -1) {
      return { error: `missing space after mode at offset ${pos}` };
    }
    const mode = Buffer.from(
      payload.buffer,
      payload.byteOffset + pos,
      spaceIndex - pos
    ).toString("utf8");

    const nulIndex = payload.indexOf(0x00, spaceIndex + 1);
    if (nulIndex === -1) {
      return { error: `missing NUL after name at offset ${spaceIndex + 1}` };
    }
    const name = Buffer.from(
      payload.buffer,
      payload.byteOffset + spaceIndex + 1,
      nulIndex - (spaceIndex + 1)
    ).toString("utf8");

    const shaStart = nulIndex + 1;
    const shaEnd = shaStart + SHA_BYTES;
    if (shaEnd > payload.length) {
      return { error: `truncated SHA at offset ${shaStart}` };
    }
    const sha = Buffer.from(
      payload.buffer,
      payload.byteOffset + shaStart,
      SHA_BYTES
    ).toString("hex");

    entries.push({
      mode,
      name,
      sha,
      kind: mode === MODE_TREE ? "tree" : "blob",
    });

    pos = shaEnd;
  }

  return entries;
}
