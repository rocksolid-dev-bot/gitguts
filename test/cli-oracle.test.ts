import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { renderCensus } from "../src/cli.js";
import { storageCensus } from "../src/index.js";

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
