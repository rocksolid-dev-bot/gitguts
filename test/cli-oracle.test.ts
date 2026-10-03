import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { renderCensus, renderDeltaChains, renderLargestObjects } from "../src/cli.js";
import { storageCensus, deltaStats, largestObjects } from "../src/index.js";

const FIXTURES_ROOT = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos"
);

/** Parses `git count-objects -v`'s `key: value` lines, live, every time --
 * the same oracle `summary-oracle.test.ts` uses for `storageCensus`
 * itself. This suite's job is the renderer sitting on top of it, not a
 * second copy of that oracle test. */
function parseCountObjects(dir: string): { count: number; inPack: number; packs: number } {
  const out = execFileSync("git", ["-C", dir, "count-objects", "-v"])
    .toString("utf8")
    .trimEnd();
  const get = (key: string): number => {
    const m = out.match(new RegExp(`^${key}: (\\d+)$`, "m"));
    if (!m) {
      throw new Error(`count-objects -v output missing "${key}:": ${out}`);
    }
    return Number(m[1]);
  };
  return { count: get("count"), inPack: get("in-pack"), packs: get("packs") };
}

describe("cli-oracle: renderCensus lines against the live count-objects -v oracle", () => {
  for (const fixture of ["basic", "packed"] as const) {
    it(`${fixture}: loose count and packed count/packs appear in renderCensus's text`, () => {
      const repoDir = join(FIXTURES_ROOT, fixture);
      const oracle = parseCountObjects(repoDir);
      const census = storageCensus(join(repoDir, ".git"));
      const text = renderCensus(census);

      expect(text).toContain(`loose objects      ${oracle.count}   (`);
      expect(text).toContain(`packs              ${oracle.packs}   ${oracle.inPack} objects`);
    });
  }

  it("basic (no pack): packs line reads 0 packs, 0 objects -- a value, never blank", () => {
    const repoDir = join(FIXTURES_ROOT, "basic");
    const census = storageCensus(join(repoDir, ".git"));
    const text = renderCensus(census);
    expect(text).toContain("packs              0   0 objects");
  });
});

/** Parses `git verify-pack -v`'s tail into a depth histogram, live --
 * the same oracle `summary-oracle.test.ts` uses for `deltaStats` itself. */
function parseVerifyPackHistogram(repoDir: string): { maxDepth: number; deltified: number } {
  const packDir = join(repoDir, ".git/objects/pack");
  const idxFile = readdirSync(packDir).find((f) => f.endsWith(".idx"));
  if (!idxFile) {
    return { maxDepth: 0, deltified: 0 };
  }
  const out = execFileSync("git", ["verify-pack", "-v", join(packDir, idxFile)]).toString("utf8");
  let maxDepth = 0;
  let deltified = 0;
  for (const m of out.matchAll(/^chain length = (\d+): (\d+) objects$/gm)) {
    const depth = Number(m[1]);
    const count = Number(m[2]);
    maxDepth = Math.max(maxDepth, depth);
    deltified += count;
  }
  return { maxDepth, deltified };
}

describe("cli-oracle: renderDeltaChains against the live verify-pack -v oracle", () => {
  it("packed: max depth and deltified count match", () => {
    const repoDir = join(FIXTURES_ROOT, "packed");
    const oracle = parseVerifyPackHistogram(repoDir);
    const stats = deltaStats(join(repoDir, ".git"));
    const text = renderDeltaChains(stats);
    expect(text).toBe(`  delta chains     max depth ${oracle.maxDepth}, ${oracle.deltified} deltified`);
  });

  it("basic (no pack): honest zero line, never NaN", () => {
    const repoDir = join(FIXTURES_ROOT, "basic");
    const stats = deltaStats(join(repoDir, ".git"));
    const text = renderDeltaChains(stats);
    expect(text).toBe("  delta chains     max depth 0, 0 deltified");
    expect(text).not.toContain("NaN");
  });
});

describe("cli-oracle: renderLargestObjects against the live cat-file -s oracle", () => {
  it("packed: SHAs, sizes and the HEAD-reachable path all match git's own view", () => {
    const repoDir = join(FIXTURES_ROOT, "packed");
    const lsTreeR = execFileSync("git", ["-C", repoDir, "ls-tree", "-r", "HEAD"])
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const [, , headSha, headPath] = lsTreeR[0].split(/\s+/);

    const top3 = largestObjects(repoDir, 3);
    const text = renderLargestObjects(top3);
    const lines = text.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0].startsWith("largest blobs      ")).toBe(true);
    expect(lines[1].startsWith(" ".repeat(19))).toBe(true);

    for (const obj of top3) {
      const oracleSize = Number(
        execFileSync("git", ["-C", repoDir, "cat-file", "-s", obj.sha]).toString("utf8").trim()
      );
      expect(obj.size).toBe(oracleSize);
      expect(text).toContain(obj.sha.slice(0, 7));
    }
    const headEntry = top3.find((o) => o.sha === headSha);
    if (headEntry) {
      expect(text).toContain(headPath);
    }
    // The two unreachable revisions render "-", never "unknown".
    expect(top3.filter((o) => o.path === null).length).toBeGreaterThan(0);
    expect(text).toContain("  -");
  });
});
