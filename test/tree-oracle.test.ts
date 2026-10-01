import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readLooseObject } from "../src/loose.js";
import { parseTree, type TreeEntry } from "../src/tree.js";

const NESTED_DIR = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos/nested"
);
const BASIC_DIR = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos/basic"
);

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args]).toString("utf8").trimEnd();
}

// Loose object store layout: `.git/objects/<first two hex chars>/<rest>`.
function readLooseTree(dir: string, sha: string): TreeEntry[] {
  const path = join(dir, ".git/objects", sha.slice(0, 2), sha.slice(2));
  const bytes = readFileSync(path);
  const obj = readLooseObject(new Uint8Array(bytes));
  if ("error" in obj) {
    throw new Error(`fixture tree ${sha} unreadable: ${obj.error}`);
  }
  expect(obj.type).toBe("tree");
  const entries = parseTree(obj.payload);
  if ("error" in entries) {
    throw new Error(`parseTree failed on ${sha}: ${entries.error}`);
  }
  return entries;
}

describe("tree-oracle: nested fixture", () => {
  let rootSha: string;
  let srcSha: string;

  beforeAll(() => {
    rootSha = git(NESTED_DIR, "rev-parse", "HEAD^{tree}");
    const rootListing = git(NESTED_DIR, "ls-tree", rootSha);
    const srcLine = rootListing
      .split("\n")
      .find((l) => l.endsWith("\tsrc"));
    if (!srcLine) throw new Error("fixture missing src/ at root");
    srcSha = srcLine.split(/\s+/)[2];
  });

  it("size reconciliation: sum(mode.length + 1 + name.length + 1 + 20) equals git cat-file -s", () => {
    const sizeOf = (entries: TreeEntry[]) =>
      entries.reduce(
        (sum, e) => sum + e.mode.length + 1 + e.name.length + 1 + 20,
        0
      );

    const root = readLooseTree(NESTED_DIR, rootSha);
    expect(sizeOf(root)).toBe(Number(git(NESTED_DIR, "cat-file", "-s", rootSha)));
    expect(Number(git(NESTED_DIR, "cat-file", "-s", rootSha))).toBe(65);

    const src = readLooseTree(NESTED_DIR, srcSha);
    expect(sizeOf(src)).toBe(Number(git(NESTED_DIR, "cat-file", "-s", srcSha)));
    expect(Number(git(NESTED_DIR, "cat-file", "-s", srcSha))).toBe(31);

    const basicTreeLine = git(BASIC_DIR, "ls-tree", "HEAD");
    // basic has one file at root; its tree sha is read from the commit.
    const basicRootSha = git(BASIC_DIR, "rev-parse", "HEAD^{tree}");
    const basic = readLooseTree(BASIC_DIR, basicRootSha);
    expect(sizeOf(basic)).toBe(Number(git(BASIC_DIR, "cat-file", "-s", basicRootSha)));
    expect(Number(git(BASIC_DIR, "cat-file", "-s", basicRootSha))).toBe(33);
    void basicTreeLine;
  });

  it("set equality against git ls-tree HEAD (non-recursive), both directions", () => {
    const root = readLooseTree(NESTED_DIR, rootSha);
    expect(root).toHaveLength(2);

    const lsTreeLines = git(NESTED_DIR, "ls-tree", rootSha)
      .split("\n")
      .filter(Boolean);
    expect(lsTreeLines).toHaveLength(2);

    const expected = new Map<string, { kind: string; sha: string; size?: number }>();
    for (const line of lsTreeLines) {
      const [modeTypeInfo, name] = line.split("\t");
      const [, type, sha] = modeTypeInfo.split(/\s+/);
      expected.set(name, { kind: type, sha });
    }

    const actual = new Map(root.map((e) => [e.name, { kind: e.kind, sha: e.sha }]));

    // Both directions: every expected name/kind/sha present in actual, and
    // nothing extra in actual.
    expect(actual.size).toBe(expected.size);
    for (const [name, exp] of expected) {
      const act = actual.get(name);
      expect(act, `missing entry ${name}`).toBeDefined();
      expect(act!.kind).toBe(exp.kind);
      expect(act!.sha).toBe(exp.sha);
    }

    const srcEntry = root.find((e) => e.name === "src")!;
    const topEntry = root.find((e) => e.name === "top.txt")!;
    expect(srcEntry.kind).toBe("tree");
    expect(topEntry.kind).toBe("blob");
    expect(Number(git(NESTED_DIR, "cat-file", "-s", srcEntry.sha))).toBe(31);
    expect(Number(git(NESTED_DIR, "cat-file", "-s", topEntry.sha))).toBe(4);
  });

  it("mode asserted in both spellings: raw five-char string, normalised against ls-tree separately", () => {
    const root = readLooseTree(NESTED_DIR, rootSha);
    const srcEntry = root.find((e) => e.name === "src")!;

    // Raw mode as the bytes spell it: five characters, no leading zero. A
    // parser that helpfully zero-pads to six characters goes red here.
    expect(srcEntry.mode).toBe("40000");
    expect(srcEntry.mode.length).toBe(5);

    // Normalisation against ls-tree's six-character spelling happens here,
    // in the test, on exactly one side (zero-pad the raw mode) -- never in
    // the parser, which returns what the bytes say.
    const lsTreeMode = git(NESTED_DIR, "ls-tree", rootSha)
      .split("\n")
      .find((l) => l.endsWith("\tsrc"))!
      .split(/\s+/)[0];
    expect(lsTreeMode).toBe("040000");
    expect(srcEntry.mode.padStart(6, "0")).toBe(lsTreeMode);
  });
});
