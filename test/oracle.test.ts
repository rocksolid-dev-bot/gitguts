import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readLooseObject } from "../src/loose.js";

const FIXTURE_DIR = join(
  new URL(".", import.meta.url).pathname,
  "fixtures/repos/basic"
);
const OBJECTS_DIR = join(FIXTURE_DIR, ".git/objects");

function gitCatFile(flag: string, sha: string): string {
  return execFileSync("git", ["-C", FIXTURE_DIR, "cat-file", flag, sha])
    .toString("utf8")
    .trimEnd();
}

function gitCatFileRaw(sha: string): Buffer {
  // `cat-file -p` pretty-prints trees as text listings, not raw bytes.
  // `cat-file --batch` streams "<sha> <type> <size>\n<raw contents>\n"
  // for every object type uniformly, which is what byte-equality needs.
  const out = execFileSync("git", ["-C", FIXTURE_DIR, "cat-file", "--batch"], {
    input: sha + "\n",
  });
  const headerEnd = out.indexOf(0x0a);
  const header = out.subarray(0, headerEnd).toString("utf8");
  const size = Number(header.split(" ")[2]);
  return out.subarray(headerEnd + 1, headerEnd + 1 + size);
}

function listLooseObjects(): string[] {
  const shas: string[] = [];
  for (const dir of readdirSync(OBJECTS_DIR)) {
    if (dir === "pack" || dir === "info") continue;
    const dirPath = join(OBJECTS_DIR, dir);
    for (const file of readdirSync(dirPath)) {
      shas.push(dir + file);
    }
  }
  return shas;
}

describe("oracle: readLooseObject against git cat-file", () => {
  const shas = listLooseObjects();

  it("finds a non-empty set of loose objects", () => {
    expect(shas.length).toBeGreaterThan(0);
  });

  it("covers exactly the three known object types", () => {
    const seenTypes = new Set<string>();
    for (const sha of shas) {
      const bytes = readFileSync(join(OBJECTS_DIR, sha.slice(0, 2), sha.slice(2)));
      const result = readLooseObject(bytes);
      if (!("error" in result)) {
        seenTypes.add(result.type);
      }
    }
    expect(seenTypes).toEqual(new Set(["commit", "tree", "blob"]));
    expect(shas.length).toBe(3);
  });

  for (const sha of shas) {
    describe(`object ${sha}`, () => {
      const bytes = readFileSync(join(OBJECTS_DIR, sha.slice(0, 2), sha.slice(2)));
      const result = readLooseObject(bytes);

      it("does not return an error", () => {
        expect("error" in result).toBe(false);
      });

      if (!("error" in result)) {
        it("type matches git cat-file -t", () => {
          expect(result.type).toBe(gitCatFile("-t", sha));
        });

        it("size matches git cat-file -s", () => {
          expect(result.size).toBe(Number(gitCatFile("-s", sha)));
        });

        it("payload byte-equals git's own raw object bytes", () => {
          const expected = gitCatFileRaw(sha);
          expect(Buffer.from(result.payload).equals(expected)).toBe(true);
        });

        it("re-hashes to the object's own SHA", () => {
          const header = `${result.type} ${result.size}\0`;
          const full = Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(result.payload)]);
          const digest = createHash("sha1").update(full).digest("hex");
          expect(digest).toBe(sha);
        });
      }
    });
  }
});
