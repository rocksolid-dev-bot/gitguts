import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeTreeLoader } from "../src/store.js";
import { walkTree } from "../src/tree.js";

const PACKED_DIR = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos/packed"
);

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args]).toString("utf8").trimEnd();
}

function hasLooseObject(dir: string, sha: string): boolean {
  return existsSync(
    join(dir, ".git/objects", sha.slice(0, 2), sha.slice(2))
  );
}

describe("store-oracle: makeTreeLoader resolves packed trees", () => {
  let rootSha: string;

  beforeAll(() => {
    rootSha = git(PACKED_DIR, "rev-parse", "HEAD^{tree}");
  });

  it("walks the packed fixture's HEAD tree, set-compared against git ls-tree -r HEAD", () => {
    const load = makeTreeLoader(PACKED_DIR);
    const result = walkTree(rootSha, load);
    if ("error" in result) {
      throw new Error(`walkTree over packed fixture failed: ${result.error}`);
    }

    const lsTreeRLines = git(PACKED_DIR, "ls-tree", "-r", "HEAD")
      .split("\n")
      .filter(Boolean);
    const expected = new Map<string, string>();
    for (const line of lsTreeRLines) {
      const [modeTypeInfo, path] = line.split("\t");
      const sha = modeTypeInfo.split(/\s+/)[2];
      expected.set(path, sha);
    }

    // Both directions, exact path set and exact SHAs -- not just "contains".
    expect(Object.keys(result).length).toBe(expected.size);
    for (const [path, sha] of expected) {
      expect(result[path], `missing path ${path}`).toBe(sha);
    }
  });

  it("proves the packed path was actually taken: the root tree has no loose object in this fixture", () => {
    // `repack -adq` left the packed/ fixture with no loose objects at all
    // (git count-objects -v: count 0, in-pack 12) -- so a loader that
    // silently fell back to a loose-only path would find nothing here and
    // the test above would be proving the wrong thing. Assert the premise
    // directly: the root tree's SHA has no loose object on disk.
    expect(hasLooseObject(PACKED_DIR, rootSha)).toBe(false);

    // And confirm the loader still resolved it -- the packed branch of
    // makeTreeLoader, not a silent no-op.
    const load = makeTreeLoader(PACKED_DIR);
    const resolved = load(rootSha);
    expect("error" in resolved).toBe(false);
  });

  it("a SHA absent from both loose storage and every pack returns a PackError, never a throw", () => {
    const load = makeTreeLoader(PACKED_DIR);
    const bogusSha = "0".repeat(40);
    const result = load(bogusSha);
    expect("error" in result).toBe(true);
  });
});
