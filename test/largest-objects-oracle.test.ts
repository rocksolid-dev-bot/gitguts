import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { largestObjects } from "../src/index.js";

const FIXTURES_ROOT = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos"
);

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args]).toString("utf8").trimEnd();
}

describe("largest-objects-oracle: largestObjects against git cat-file -s / ls-tree", () => {
  const repoDir = join(FIXTURES_ROOT, "packed");

  it("the four 3510-byte blobs tie, read live from git cat-file -s, not hardcoded", () => {
    // Every object git names in this pack, read live rather than assumed.
    const allShas = git(repoDir, "cat-file", "--batch-check", "--batch-all-objects")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[0]);
    const sizes = allShas.map((sha) => ({
      sha,
      size: Number(git(repoDir, "cat-file", "-s", sha)),
    }));
    const tiedAt3510 = sizes.filter((s) => s.size === 3510).map((s) => s.sha).sort();
    expect(tiedAt3510.length).toBe(4);

    // 3a: top-4 SET equals the four 3510-byte SHAs.
    const top4 = largestObjects(repoDir, 4);
    expect(top4.map((o) => o.sha).sort()).toEqual(tiedAt3510);
    expect(top4.every((o) => o.size === 3510)).toBe(true);
    expect(top4.every((o) => o.type === "blob")).toBe(true);
  });

  it("3b: with the SHA tie-break applied, the order is exactly reproducible", () => {
    const run1 = largestObjects(repoDir, 4).map((o) => o.sha);
    const run2 = largestObjects(repoDir, 4).map((o) => o.sha);
    expect(run1).toEqual(run2);
    const sortedAscending = [...run1].sort();
    expect(run1).toEqual(sortedAscending);
  });

  it("3c: the live HEAD blob resolves to big.txt; the three unreachable revisions resolve to null", () => {
    const lsTreeR = git(repoDir, "ls-tree", "-r", "HEAD");
    // Exactly one row at HEAD -- the other three 3510-byte blobs are older
    // revisions, reachable from history but not from HEAD's tree.
    const rows = lsTreeR.split("\n").filter(Boolean);
    expect(rows.length).toBe(1);
    const [, , headSha, headPath] = rows[0].split(/\s+/);
    expect(headPath).toBe("big.txt");

    const top4 = largestObjects(repoDir, 4);
    const headEntry = top4.find((o) => o.sha === headSha);
    expect(headEntry?.path).toBe("big.txt");
    const others = top4.filter((o) => o.sha !== headSha);
    expect(others.length).toBe(3);
    expect(others.every((o) => o.path === null)).toBe(true);
  });

  it("3d: summed sizes over all 12 objects is 15112, the reconstructed total -- not the stored-size-column 4657", () => {
    const all = largestObjects(repoDir, 12);
    expect(all.length).toBe(12);
    const total = all.reduce((sum, o) => sum + o.size, 0);
    expect(total).toBe(15112);

    // The 4657 trap, confirmed from verify-pack's own stored-size column.
    const packDir = join(repoDir, ".git/objects/pack");
    const idxFile = readdirSync(packDir).find((f) => f.endsWith(".idx"))!;
    const verifyOut = execFileSync("git", [
      "verify-pack",
      "-v",
      join(packDir, idxFile),
    ]).toString("utf8");
    const storedSizeSum = [...verifyOut.matchAll(/^\S+\s+\S+\s+(\d+)\s+\d+\s+\d+/gm)].reduce(
      (sum, m) => sum + Number(m[1]),
      0
    );
    expect(storedSizeSum).toBe(4657);
  });

  for (const fixture of ["basic", "nested"] as const) {
    it(`3e: ${fixture} (loose-only) returns its loose objects without throwing`, () => {
      const dir = join(FIXTURES_ROOT, fixture);
      const result = largestObjects(dir, 10);
      expect(result.length).toBeGreaterThan(0);
      for (const o of result) {
        expect(["commit", "tree", "blob", "tag"]).toContain(o.type);
        expect(o.size).toBeGreaterThan(0);
      }
    });
  }
});
