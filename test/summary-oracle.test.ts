import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { storageCensus } from "../src/index.js";

const FIXTURES_ROOT = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos"
);

const FIXTURES = ["basic", "nested", "packed"] as const;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args]).toString("utf8").trimEnd();
}

interface OracleCounts {
  count: number;
  inPack: number;
  packs: number;
}

/** Parses `git count-objects -v`'s `key: value` lines into the three
 * fields this module cares about. Parsed from the live command's output
 * every time -- never hardcoded -- so a regenerated fixture is still
 * compared against truth. */
function parseCountObjects(dir: string): OracleCounts {
  const out = git(dir, "count-objects", "-v");
  const get = (key: string): number => {
    const m = out.match(new RegExp(`^${key}: (\\d+)$`, "m"));
    if (!m) {
      throw new Error(`count-objects -v output missing "${key}:": ${out}`);
    }
    return Number(m[1]);
  };
  return { count: get("count"), inPack: get("in-pack"), packs: get("packs") };
}

/** Sums the on-disk size of every file matching the loose-object shape
 * (`<2 hex>/<38 hex>` under `objects/`), independently of `storageCensus`'s
 * own walk, as the oracle for `loose.bytes`. */
function sumLooseFileSizes(repoDir: string): number {
  const objectsDir = join(repoDir, ".git/objects");
  const hex2 = /^[0-9a-f]{2}$/;
  const hex38 = /^[0-9a-f]{38}$/;
  let total = 0;
  for (const sub of readdirSync(objectsDir)) {
    if (!hex2.test(sub)) continue;
    const subdir = join(objectsDir, sub);
    if (!statSync(subdir).isDirectory()) continue;
    for (const file of readdirSync(subdir)) {
      if (!hex38.test(file)) continue;
      total += statSync(join(subdir, file)).size;
    }
  }
  return total;
}

/** The naive implementation the item warns against: every file under
 * `objects/` that is not inside `pack/`, with no shape check. Used only to
 * prove the trap is real -- `objects/info/packs` in the `packed` fixture
 * is not an object, and this walker counts it anyway. */
function naiveLooseCount(repoDir: string): number {
  const objectsDir = join(repoDir, ".git/objects");
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === "pack") continue;
        walk(full);
      } else {
        count++;
      }
    }
  };
  walk(objectsDir);
  return count;
}

describe("summary-oracle: storageCensus against git count-objects -v", () => {
  for (const fixture of FIXTURES) {
    const repoDir = join(FIXTURES_ROOT, fixture);
    const gitDir = join(repoDir, ".git");

    it(`${fixture}: count/in-pack/packs match the live oracle`, () => {
      const oracle = parseCountObjects(repoDir);
      const census = storageCensus(gitDir);
      expect(census.loose.count).toBe(oracle.count);
      expect(census.packed.count).toBe(oracle.inPack);
      expect(census.packed.packs).toBe(oracle.packs);
    });

    it(`${fixture}: loose.bytes equals the statSync sum over matched files`, () => {
      const census = storageCensus(gitDir);
      expect(census.loose.bytes).toBe(sumLooseFileSizes(repoDir));
    });
  }

  it("packed fixture: the naive pack-exclusion walker miscounts info/packs as loose (1), storageCensus does not (0)", () => {
    const repoDir = join(FIXTURES_ROOT, "packed");
    expect(existsSync(join(repoDir, ".git/objects/info/packs"))).toBe(true);
    const naive = naiveLooseCount(repoDir);
    expect(naive).toBe(1);
    const census = storageCensus(join(repoDir, ".git"));
    expect(census.loose.count).toBe(0);
  });
});
