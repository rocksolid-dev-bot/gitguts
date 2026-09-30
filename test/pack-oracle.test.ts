import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readIdx, lookupBySha, type Idx } from "../src/idx.js";
import { resolvePackObject } from "../src/pack.js";

const PACKED_DIR = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos/packed"
);
const PACK_DIR = join(PACKED_DIR, ".git/objects/pack");

// Discover the .idx/.pack by glob, never a hardcoded name — same reason
// test/idx-oracle.test.ts does: the pack name is content-derived, and the
// dir also holds a .rev file.
function findPaths(): { idxPath: string; packPath: string } {
  const files = readdirSync(PACK_DIR);
  const idxFile = files.find((f) => f.endsWith(".idx"));
  const packFile = files.find((f) => f.endsWith(".pack"));
  if (!idxFile || !packFile) {
    throw new Error(`no .idx/.pack pair found in ${PACK_DIR}`);
  }
  return { idxPath: join(PACK_DIR, idxFile), packPath: join(PACK_DIR, packFile) };
}

function gitCatFile(flag: string, sha: string): string {
  return execFileSync("git", ["-C", PACKED_DIR, "cat-file", flag, sha])
    .toString("utf8")
    .trimEnd();
}

function gitCatFileRaw(sha: string): Buffer {
  // `-p` pretty-prints trees as text listings, not raw bytes (day 1's
  // finding, carried forward). `--batch` streams true raw content for
  // every type uniformly, which is what byte-equality needs.
  const out = execFileSync("git", ["-C", PACKED_DIR, "cat-file", "--batch"], {
    input: sha + "\n",
  });
  const headerEnd = out.indexOf(0x0a);
  const header = out.subarray(0, headerEnd).toString("utf8");
  const size = Number(header.split(" ")[2]);
  return out.subarray(headerEnd + 1, headerEnd + 1 + size);
}

interface VerifyPackEntry {
  type: string;
  offset: number;
  depth?: number;
  baseSha?: string;
}

// Parses `git verify-pack -v` into sha -> {type, offset, depth?, baseSha?}.
// The trailing `<path>: ok` summary line is not an object line and must be
// excluded — a naive parse over every line breaks on it (day 2's finding).
// Delta lines carry two extra trailing columns (depth, base sha) that
// non-delta lines do not; both shapes must parse under the same regex.
function gitVerifyPackEntries(idxPath: string): Map<string, VerifyPackEntry> {
  const out = execFileSync("git", ["verify-pack", "-v", idxPath]).toString(
    "utf8"
  );
  const entries = new Map<string, VerifyPackEntry>();
  for (const line of out.split("\n")) {
    const m = line.match(
      /^([0-9a-f]{40})\s+(\S+)\s+\d+\s+\d+\s+(\d+)(?:\s+(\d+)\s+([0-9a-f]{40}))?/
    );
    if (m) {
      entries.set(m[1], {
        type: m[2],
        offset: Number(m[3]),
        depth: m[4] !== undefined ? Number(m[4]) : undefined,
        baseSha: m[5],
      });
    }
  }
  return entries;
}

describe("oracle: resolvePackObject against git cat-file / git verify-pack -v", () => {
  let idx: Idx;
  let packBuf: Uint8Array;
  let verifyPackEntries: Map<string, VerifyPackEntry>;
  let deltaShas: string[];

  beforeAll(() => {
    const { idxPath, packPath } = findPaths();
    const idxResult = readIdx(new Uint8Array(readFileSync(idxPath)));
    if ("error" in idxResult) {
      throw new Error(`readIdx failed: ${idxResult.error}`);
    }
    idx = idxResult;
    packBuf = new Uint8Array(readFileSync(packPath));
    verifyPackEntries = gitVerifyPackEntries(idxPath);
    deltaShas = [...verifyPackEntries.entries()]
      .filter(([, e]) => e.depth !== undefined)
      .map(([sha]) => sha);
  });

  function resolveBySha(sha: string) {
    const entry = lookupBySha(idx, sha);
    if (!entry) {
      throw new Error(`fixture inconsistency: ${sha} not found in .idx`);
    }
    return entry;
  }

  it("git verify-pack -v reports exactly 3 delta objects, each depth 1", () => {
    expect(deltaShas.length).toBe(3);
    for (const sha of deltaShas) {
      expect(verifyPackEntries.get(sha)?.depth).toBe(1);
    }
  });

  describe("the 3 delta objects reconstruct byte-identical to git, at the right depth", () => {
    for (const sha of ["c7dc7f06047662fdeaa343392c3ec2f79f8e8d39",
      "fe831487599d1e39148627175d4d2d7ef17336e2",
      "3336c5f9e69e0b64f3e67d2fd7d40c7b7eb0e7a3"]) {
      it(`resolves ${sha}`, () => {
        const entry = resolveBySha(sha);
        const resolved = resolvePackObject(packBuf, entry.offset, resolveBySha);
        if ("error" in resolved) {
          throw new Error(`resolvePackObject failed for ${sha}: ${resolved.error}`);
        }

        expect(resolved.type).toBe("blob");
        expect(resolved.size).toBe(3510);
        expect(resolved.payload.length).toBe(3510);
        expect(resolved.depth).toBe(1);
        expect(resolved.depth).toBe(verifyPackEntries.get(sha)?.depth);

        const expected = gitCatFileRaw(sha);
        expect(Buffer.from(resolved.payload).equals(expected)).toBe(true);
      });
    }
  });

  it("a reconstructor that silently returned the base would fail here: content differs from the base, not just sizes", () => {
    const deltaEntry = resolveBySha("c7dc7f06047662fdeaa343392c3ec2f79f8e8d39");
    const baseEntry = resolveBySha("80c0c57b260b8b6ab41a54722cb3720f5e20859c");

    const delta = resolvePackObject(packBuf, deltaEntry.offset, resolveBySha);
    const base = resolvePackObject(packBuf, baseEntry.offset, resolveBySha);
    if ("error" in delta) throw new Error(delta.error);
    if ("error" in base) throw new Error(base.error);

    // Both are 3510 bytes — sizes alone cannot distinguish them.
    expect(delta.payload.length).toBe(base.payload.length);

    const deltaLine10 = Buffer.from(delta.payload).toString("utf8").split("\n")[9];
    const baseLine10 = Buffer.from(base.payload).toString("utf8").split("\n")[9];

    expect(deltaLine10).toBe("line 10 edit3");
    expect(baseLine10).toBe("line 10 edit4");
    expect(deltaLine10).not.toBe(baseLine10);
  });

  it("reconstructs all 12 objects the .idx enumerates, matching git cat-file -t/-s for each", () => {
    expect(idx.entries.length).toBe(12);

    const seenTypes = new Set<string>();
    for (const entry of idx.entries) {
      const resolved = resolvePackObject(packBuf, entry.offset, resolveBySha);
      if ("error" in resolved) {
        throw new Error(`resolvePackObject failed for ${entry.sha}: ${resolved.error}`);
      }
      expect(resolved.type).toBe(gitCatFile("-t", entry.sha));
      expect(resolved.size).toBe(Number(gitCatFile("-s", entry.sha)));
      expect(resolved.payload.length).toBe(resolved.size);
      seenTypes.add(resolved.type);
    }

    // The type-coverage set: a blob reached only through a delta must
    // still report "blob", not some delta-specific pseudo-type.
    expect(seenTypes).toEqual(new Set(["commit", "tree", "blob"]));
  });
});
