import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveObjectBySha } from "../src/index.js";
import { main } from "../src/cli.js";

const FIXTURES_ROOT = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos"
);

const FIXTURE_DIRS = ["basic", "packed", "nested"] as const;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args]).toString("utf8").trimEnd();
}

/** Every object in a fixture, by SHA -- the same enumeration
 * `test/oracle.test.ts` uses for the loose-only `basic` fixture, extended
 * here to every fixture including packed storage. */
function listAllObjects(dir: string): string[] {
  const out = git(dir, "cat-file", "--batch-all-objects", "--batch-check");
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(" ")[0]!);
}

describe("resolveObjectBySha: every object in every fixture, against git", () => {
  for (const fixture of FIXTURE_DIRS) {
    const dir = join(FIXTURES_ROOT, fixture);
    const shas = listAllObjects(dir);
    it(`${fixture}: has at least one object to check`, () => {
      expect(shas.length).toBeGreaterThan(0);
    });
    for (const sha of shas) {
      it(`${fixture} ${sha.slice(0, 7)}: type and size match git cat-file`, () => {
        const expectedType = git(dir, "cat-file", "-t", sha);
        const expectedSize = Number(git(dir, "cat-file", "-s", sha));
        const resolved = resolveObjectBySha(dir, sha);
        expect("error" in resolved).toBe(false);
        if (!("error" in resolved)) {
          expect(resolved.type).toBe(expectedType);
          expect(resolved.size).toBe(expectedSize);
        }
      });
    }
  }
});

describe("resolveObjectBySha: storage label", () => {
  it("packed fixture objects report storage: packed", () => {
    const dir = join(FIXTURES_ROOT, "packed");
    const [sha] = listAllObjects(dir);
    const resolved = resolveObjectBySha(dir, sha!);
    expect("error" in resolved).toBe(false);
    if (!("error" in resolved)) {
      expect(resolved.storage).toBe("packed");
    }
  });

  it("basic fixture objects (all loose) report storage: loose", () => {
    const dir = join(FIXTURES_ROOT, "basic");
    const [sha] = listAllObjects(dir);
    const resolved = resolveObjectBySha(dir, sha!);
    expect("error" in resolved).toBe(false);
    if (!("error" in resolved)) {
      expect(resolved.storage).toBe("loose");
    }
  });

  it("unknown sha returns an error value, never throws", () => {
    const dir = join(FIXTURES_ROOT, "basic");
    const resolved = resolveObjectBySha(dir, "0".repeat(40));
    expect("error" in resolved).toBe(true);
  });
});

describe("gitguts object <sha>: CLI error paths", () => {
  it("unknown sha: exit 1, one line, no stack trace", () => {
    const writes: string[] = [];
    const spy = vi_spyStdout(writes);
    const code = main([
      "node",
      "cli.js",
      "object",
      "0".repeat(40),
      join(FIXTURES_ROOT, "packed"),
    ]);
    spy.restore();
    expect(code).toBe(1);
    const output = writes.join("");
    expect(output.split("\n").filter((l) => l.length > 0).length).toBe(1);
    expect(output.includes("at ")).toBe(false);
  });

  it("missing sha: exit 1, one line", () => {
    const writes: string[] = [];
    const spy = vi_spyStdout(writes);
    const code = main(["node", "cli.js", "object"]);
    spy.restore();
    expect(code).toBe(1);
    const output = writes.join("");
    expect(output.split("\n").filter((l) => l.length > 0).length).toBe(1);
  });
});

// Minimal stdout capture, local to this file -- the suite otherwise never
// asserts on captured stdout (cli-oracle.test.ts exercises `main` only via
// its pure renderers), so this helper stays here rather than becoming a
// shared convention.
function vi_spyStdout(sink: string[]) {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    sink.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
    },
  };
}
