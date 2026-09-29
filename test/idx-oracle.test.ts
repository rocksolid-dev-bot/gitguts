import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readIdx, lookupBySha, type Idx } from "../src/idx.js";

const PACKED_DIR = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos/packed"
);
const BASIC_DIR = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos/basic"
);
const PACK_DIR = join(PACKED_DIR, ".git/objects/pack");

// Discover the .idx by glob, never by a hardcoded filename: the pack name
// is content-derived and arbitrary, and the pack dir also holds a .rev
// file that git 2.43 writes alongside .idx/.pack.
function findIdxPath(): string {
  const idxFile = readdirSync(PACK_DIR).find((f) => f.endsWith(".idx"));
  if (!idxFile) {
    throw new Error(`no .idx file found in ${PACK_DIR}`);
  }
  return join(PACK_DIR, idxFile);
}

// Parse `git verify-pack -v` output into the same shape as our reader, so
// the two can be compared as sets. Git reads the .pack; we read the .idx —
// genuinely different methods against the same ground truth.
//
// The trailing `<path>: ok` summary line is not an object line and must be
// excluded, or a naive diff silently breaks on it.
function gitVerifyPackEntries(idxPath: string): Map<string, number> {
  const out = execFileSync("git", ["verify-pack", "-v", idxPath]).toString(
    "utf8"
  );
  // Columns are whitespace-padded (e.g. "blob   " vs "commit "), so fields
  // must be split on \s+, not a literal single space — a single-space
  // regex silently drops every "blob"/"tree" line and keeps only "commit",
  // which is exactly the kind of failure a set-size assertion catches.
  const entries = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = line.match(/^([0-9a-f]{40})\s+\S+\s+\d+\s+\d+\s+(\d+)/);
    if (m) {
      entries.set(m[1], Number(m[2]));
    }
  }
  return entries;
}

describe("oracle: readIdx / lookupBySha against git verify-pack -v", () => {
  let idx: Idx;
  let idxPath: string;
  let verifyPackEntries: Map<string, number>;

  beforeAll(() => {
    idxPath = findIdxPath();
    const bytes = readFileSync(idxPath);
    const result = readIdx(new Uint8Array(bytes));
    if ("error" in result) {
      throw new Error(`readIdx failed: ${result.error}`);
    }
    idx = result;
    verifyPackEntries = gitVerifyPackEntries(idxPath);
  });

  it("parses header: magic implied by success, version 2", () => {
    expect(idx.version).toBe(2);
  });

  it("objectCount equals fanout[255] equals entries.length (three routes, one number)", () => {
    // objectCount is read from fanout[255] inside readIdx; re-derive it
    // independently here from the raw bytes to catch a copy/paste bug.
    const bytes = readFileSync(idxPath);
    const fanout255 = bytes.readUInt32BE(8 + 255 * 4);
    expect(idx.objectCount).toBe(fanout255);
    expect(idx.entries.length).toBe(fanout255);
    expect(idx.objectCount).toBe(12);
  });

  it("git verify-pack -v reports 12 object lines", () => {
    expect(verifyPackEntries.size).toBe(12);
  });

  it("the (sha, offset) set we enumerate equals git verify-pack -v's set", () => {
    const ours = new Map(idx.entries.map((e) => [e.sha, e.offset]));
    expect(ours.size).toBe(verifyPackEntries.size);
    for (const [sha, offset] of verifyPackEntries) {
      expect(ours.has(sha)).toBe(true);
      expect(ours.get(sha)).toBe(offset);
    }
  });

  it("lookupBySha resolves every present SHA to git's own offset (present direction)", () => {
    for (const [sha, offset] of verifyPackEntries) {
      const entry = lookupBySha(idx, sha);
      expect(entry).toBeDefined();
      expect(entry?.offset).toBe(offset);
    }
  });

  it("lookupBySha returns undefined for a SHA that is absent from this pack (absent direction)", () => {
    // The basic fixture's blob is loose, in a different repo, and never
    // enters this pack.
    const basicObjectsDir = join(BASIC_DIR, ".git/objects");
    let looseSha: string | undefined;
    for (const dir of readdirSync(basicObjectsDir)) {
      if (dir === "pack" || dir === "info") continue;
      for (const file of readdirSync(join(basicObjectsDir, dir))) {
        looseSha = dir + file;
      }
    }
    expect(looseSha).toBeDefined();
    expect(verifyPackEntries.has(looseSha!)).toBe(false);
    expect(lookupBySha(idx, looseSha!)).toBeUndefined();
  });

  it("does not throw on a not-found lookup, and returns a value, never a throw", () => {
    expect(() => lookupBySha(idx, "0".repeat(40))).not.toThrow();
    expect(lookupBySha(idx, "0".repeat(40))).toBeUndefined();
  });
});
