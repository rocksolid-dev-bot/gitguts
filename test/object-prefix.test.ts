// Round trip the census's own printed SHAs through resolveObjectBySha, and
// cover prefix acceptance end to end: the gap neither verb's own tests can
// see alone (mistake 59) is that the census prints abbreviated SHAs the
// object verb used to reject outright.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveObjectBySha } from "../src/index.js";
import { largestObjects } from "../src/summary.js";

const FIXTURES_ROOT = join(new URL(".", import.meta.url).pathname, "fixtures/repos");
const FIXTURE_DIRS = ["basic", "packed", "nested"] as const;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args]).toString("utf8").trimEnd();
}

describe("resolveObjectBySha: census -> object round trip, every fixture", () => {
  for (const fixture of FIXTURE_DIRS) {
    const dir = join(FIXTURES_ROOT, fixture);
    // Exactly what `largestObjects` prints under "largest objects" --
    // the same 7-char abbreviation `renderLargestObjects` slices for
    // display, fed straight back into the object verb.
    const top = largestObjects(dir, 3);

    it(`${fixture}: largestObjects has at least one row to round-trip`, () => {
      expect(top.length).toBeGreaterThan(0);
    });

    for (const obj of top) {
      const prefix = obj.sha.slice(0, 7);
      it(`${fixture} ${prefix}: census-printed prefix resolves and matches git`, () => {
        const resolved = resolveObjectBySha(dir, prefix);
        expect("error" in resolved).toBe(false);
        if ("error" in resolved) return;
        const expectedType = git(dir, "cat-file", "-t", obj.sha);
        const expectedSize = Number(git(dir, "cat-file", "-s", obj.sha));
        expect(resolved.type).toBe(expectedType);
        expect(resolved.size).toBe(expectedSize);
      });
    }
  }
});

describe("resolveObjectBySha: prefix acceptance, 1-40 hex chars", () => {
  const basic = join(FIXTURES_ROOT, "basic");
  const packed = join(FIXTURES_ROOT, "packed");
  const fullSha = "341fd1112240412b8a510174ac1457aab13326f1"; // commit, 198 B, loose
  const prefix7 = "341fd11";

  it("7-char prefix: exit-equivalent fields match the full-SHA run", () => {
    const resolved = resolveObjectBySha(basic, prefix7);
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;
    expect(resolved.type).toBe("commit");
    expect(resolved.size).toBe(198);
    expect(resolved.storage).toBe("loose");
  });

  it("full 40-char SHA: unchanged, byte-identical fields to before this change", () => {
    const resolved = resolveObjectBySha(basic, fullSha);
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;
    expect(resolved.type).toBe("commit");
    expect(resolved.size).toBe(198);
    expect(resolved.storage).toBe("loose");
  });

  it("mixed case prefix: resolves identically", () => {
    const resolved = resolveObjectBySha(basic, "341FD11");
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;
    expect(resolved.type).toBe("commit");
    expect(resolved.size).toBe(198);
    expect(resolved.storage).toBe("loose");
  });

  it("the real collision: 1-char prefix 'f' in packed matches 3 objects, ambiguous", () => {
    const resolved = resolveObjectBySha(packed, "f");
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) return;
    expect(resolved.error.toLowerCase()).toContain("ambiguous");
    expect(resolved.error).toMatch(/\b([2-9]|[1-9][0-9]+)\b/); // a count >= 2
    expect(resolved.error).not.toMatch(/\n/);
  });

  it("non-hex input: reports it is not a hex object name, no match attempted", () => {
    const resolved = resolveObjectBySha(basic, "zzzz");
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) return;
    expect(resolved.error.toLowerCase()).toContain("not a hex object name");
  });

  it("valid hex, no match: today's unchanged message", () => {
    const resolved = resolveObjectBySha(basic, "deadbeef");
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) return;
    expect(resolved.error).toContain("found in neither loose storage nor any pack");
  });

  it("over-length hex input: reported as invalid, never thrown", () => {
    const resolved = resolveObjectBySha(basic, fullSha + "0");
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) return;
    expect(resolved.error.toLowerCase()).toContain("not a hex object name");
  });
});
