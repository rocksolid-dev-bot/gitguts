// Storage census: counts and byte totals for a repo's loose and packed
// object storage. Read-only, no `git` subprocess -- that stays in `test/`
// as the oracle.
//
// The trap: `.git/objects/info/packs` is not an object, and a walker that
// takes every file under `.git/objects` and merely excludes `pack/` counts
// it, reporting one loose object where `git count-objects -v` reports zero.
// `info/` is not the only possible non-object directory, so this filters on
// the *shape* of a loose object path -- a two-hex-char subdirectory holding
// a thirty-eight-hex-char file -- rather than on "not inside pack/".

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readLooseObject } from "./loose.js";
import { readIdx, lookupBySha } from "./idx.js";
import { resolvePackObject, type PackObjectType } from "./pack.js";
import type { PackError } from "./pack.js";
import { walkTree } from "./tree.js";
import { makeTreeLoader } from "./store.js";

export interface StorageCensus {
  loose: { count: number; bytes: number };
  packed: { count: number; packs: number };
}

const HEX2 = /^[0-9a-f]{2}$/;
const HEX38 = /^[0-9a-f]{38}$/;

/**
 * Builds the loose/packed storage census for the repo whose `.git`
 * directory is `gitDir`. Loose objects are matched by path shape
 * (`<2 hex>/<38 hex>` under `objects/`), never by excluding `pack/` --
 * `objects/info/` holds non-object files and a pack-exclusion walker
 * miscounts them as loose.
 */
export function storageCensus(gitDir: string): StorageCensus {
  const objectsDir = join(gitDir, "objects");
  let looseCount = 0;
  let looseBytes = 0;
  if (existsSync(objectsDir)) {
    for (const subEntry of readdirSync(objectsDir)) {
      if (!HEX2.test(subEntry)) {
        continue;
      }
      const subdir = join(objectsDir, subEntry);
      if (!statSync(subdir).isDirectory()) {
        continue;
      }
      for (const file of readdirSync(subdir)) {
        if (!HEX38.test(file)) {
          continue;
        }
        looseCount++;
        looseBytes += statSync(join(subdir, file)).size;
      }
    }
  }

  const packDir = join(objectsDir, "pack");
  let packCount = 0;
  let packedObjectCount = 0;
  if (existsSync(packDir)) {
    const idxFiles = readdirSync(packDir).filter((f) => f.endsWith(".idx"));
    packCount = idxFiles.length;
    for (const idxFile of idxFiles) {
      const idxBuf = new Uint8Array(readFileSync(join(packDir, idxFile)));
      const idx = readIdx(idxBuf);
      if (!("error" in idx)) {
        packedObjectCount += idx.objectCount;
      }
    }
  }

  return {
    loose: { count: looseCount, bytes: looseBytes },
    packed: { count: packedObjectCount, packs: packCount },
  };
}

export interface DeltaStats {
  /** Delta chain depth -> object count at that depth. 0 = non-delta. */
  histogram: Record<number, number>;
  maxDepth: number;
  /** Mean chain depth over every object the pack(s) contain, not just the
   * deltified subset -- 1.0 over the deltified three is equally defensible
   * and the field name has to pick one; this picks "all objects". */
  meanDepth: number;
  objects: number;
}

/**
 * Builds the delta-chain depth histogram across every pack under
 * `.git/objects/pack/`. Keyed on "zero `.idx` files found", never on the
 * presence of the `pack/` directory -- `basic` and `nested` both *have* an
 * (empty) `pack/` directory, so an `existsSync(packDir)` guard takes the
 * pack-present branch on both and then globs zero `.idx` files. For a repo
 * with no packs: `histogram` `{}`, `maxDepth` 0, `objects` 0, `meanDepth`
 * 0 -- never `NaN` (0/0 is the natural output of the obvious
 * implementation and survives a loose truthiness check, so this guards it
 * explicitly).
 */
export function deltaStats(gitDir: string): DeltaStats {
  const objectsDir = join(gitDir, "objects");
  const packDir = join(objectsDir, "pack");
  const idxFiles = existsSync(packDir)
    ? readdirSync(packDir).filter((f) => f.endsWith(".idx"))
    : [];

  const histogram: Record<number, number> = {};
  let objects = 0;
  let depthSum = 0;

  for (const idxFile of idxFiles) {
    const base = idxFile.slice(0, -".idx".length);
    const packPath = join(packDir, `${base}.pack`);
    if (!existsSync(packPath)) {
      continue;
    }
    const idxBuf = new Uint8Array(readFileSync(join(packDir, idxFile)));
    const idx = readIdx(idxBuf);
    if ("error" in idx) {
      continue;
    }
    const packBuf = new Uint8Array(readFileSync(packPath));
    for (const entry of idx.entries) {
      const resolved = resolvePackObject(packBuf, entry.offset);
      if ("error" in resolved) {
        continue;
      }
      objects++;
      depthSum += resolved.depth;
      histogram[resolved.depth] = (histogram[resolved.depth] ?? 0) + 1;
    }
  }

  const maxDepth = objects === 0 ? 0 : Math.max(...Object.keys(histogram).map(Number));
  const meanDepth = objects === 0 ? 0 : depthSum / objects;

  return { histogram, maxDepth, meanDepth, objects };
}

export interface LargestObject {
  sha: string;
  type: PackObjectType;
  /** True reconstructed object size (from `cat-file -s`'s point of view),
   * never a pack's stored delta-stream length -- `git verify-pack -v`'s
   * size column reads the delta-stream size for a delta object, which
   * ranks deltas by instruction-stream length rather than by the object
   * they reconstruct to. */
  size: number;
  /** Path as resolved by walking HEAD's tree, or `null` when the object is
   * not reachable from HEAD (an older revision of a file, a commit object,
   * or anything outside the current tree). Never guessed from size or
   * from "the only path there is" -- read off the walk, or `null`. */
  path: string | null;
}

interface AnyObject {
  sha: string;
  type: PackObjectType;
  size: number;
}

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Resolves HEAD to the SHA of its commit's root tree, reading `.git/HEAD`
 * and (if symbolic) the ref file it points at or `packed-refs` as a
 * fallback, then the commit object itself for its `tree <sha>` line. No
 * `git` subprocess -- `test/` holds that as the oracle.
 */
function resolveHeadTreeSha(repoDir: string): string | PackError {
  const headPath = join(repoDir, ".git/HEAD");
  if (!existsSync(headPath)) {
    return { error: `missing ${headPath}` };
  }
  const headContent = readFileSync(headPath, "utf8").trim();
  let commitSha: string;
  if (headContent.startsWith("ref: ")) {
    const refName = headContent.slice("ref: ".length).trim();
    const refPath = join(repoDir, ".git", refName);
    if (existsSync(refPath)) {
      commitSha = readFileSync(refPath, "utf8").trim();
    } else {
      const packedRefsPath = join(repoDir, ".git/packed-refs");
      if (!existsSync(packedRefsPath)) {
        return { error: `ref ${refName} not found loose, and no packed-refs` };
      }
      const line = readFileSync(packedRefsPath, "utf8")
        .split("\n")
        .find((l) => l.endsWith(` ${refName}`));
      if (!line) {
        return { error: `ref ${refName} not found in packed-refs` };
      }
      commitSha = line.split(" ")[0];
    }
  } else if (HEX40.test(headContent)) {
    commitSha = headContent;
  } else {
    return { error: `HEAD content "${headContent}" is neither a ref nor a SHA` };
  }

  const loosePath = join(repoDir, ".git/objects", commitSha.slice(0, 2), commitSha.slice(2));
  let payload: Uint8Array;
  if (existsSync(loosePath)) {
    const obj = readLooseObject(new Uint8Array(readFileSync(loosePath)));
    if ("error" in obj) return { error: `commit ${commitSha} unreadable: ${obj.error}` };
    if (obj.type !== "commit") return { error: `${commitSha} is type ${obj.type}, not commit` };
    payload = obj.payload;
  } else {
    const packDir = join(repoDir, ".git/objects/pack");
    let resolved: AnyObject | PackError | undefined;
    if (existsSync(packDir)) {
      for (const idxFile of readdirSync(packDir).filter((f) => f.endsWith(".idx"))) {
        const idxBuf = new Uint8Array(readFileSync(join(packDir, idxFile)));
        const idx = readIdx(idxBuf);
        if ("error" in idx) continue;
        const entry = lookupBySha(idx, commitSha);
        if (!entry) continue;
        const packBuf = new Uint8Array(
          readFileSync(join(packDir, idxFile.slice(0, -".idx".length) + ".pack"))
        );
        const r = resolvePackObject(packBuf, entry.offset, (b) => lookupBySha(idx, b));
        if ("error" in r) return r;
        if (r.type !== "commit") return { error: `${commitSha} is type ${r.type}, not commit` };
        payload = r.payload;
        resolved = { sha: commitSha, type: r.type, size: r.size };
        break;
      }
    }
    if (resolved === undefined) {
      return { error: `commit ${commitSha} found in neither loose storage nor any pack` };
    }
  }

  const text = Buffer.from(payload!).toString("utf8");
  const m = text.match(/^tree ([0-9a-f]{40})$/m);
  if (!m) {
    return { error: `commit ${commitSha} payload has no "tree <sha>" line` };
  }
  return m[1];
}

/**
 * The `n` largest objects in the repo by true reconstructed size, each
 * with its path resolved by walking HEAD's tree -- `null` when the object
 * is not reachable from HEAD. Ties are broken SHA-ascending, documented
 * here rather than left to sort stability: several objects commonly tie
 * at the same size (e.g. successive revisions of one file), and a test
 * asserting one specific SHA among equals would pass or fail on sort
 * stability rather than on behaviour.
 */
export function largestObjects(repoDir: string, n: number): LargestObject[] {
  const gitDir = join(repoDir, ".git");
  const objectsDir = join(gitDir, "objects");
  const all: AnyObject[] = [];
  const seen = new Set<string>();

  if (existsSync(objectsDir)) {
    for (const subEntry of readdirSync(objectsDir)) {
      if (!/^[0-9a-f]{2}$/.test(subEntry)) continue;
      const subdir = join(objectsDir, subEntry);
      if (!statSync(subdir).isDirectory()) continue;
      for (const file of readdirSync(subdir)) {
        if (!/^[0-9a-f]{38}$/.test(file)) continue;
        const sha = subEntry + file;
        const obj = readLooseObject(new Uint8Array(readFileSync(join(subdir, file))));
        if ("error" in obj) continue;
        all.push({ sha, type: obj.type, size: obj.size });
        seen.add(sha);
      }
    }
  }

  const packDir = join(objectsDir, "pack");
  if (existsSync(packDir)) {
    for (const idxFile of readdirSync(packDir).filter((f) => f.endsWith(".idx"))) {
      const idxBuf = new Uint8Array(readFileSync(join(packDir, idxFile)));
      const idx = readIdx(idxBuf);
      if ("error" in idx) continue;
      const packPath = join(packDir, idxFile.slice(0, -".idx".length) + ".pack");
      if (!existsSync(packPath)) continue;
      const packBuf = new Uint8Array(readFileSync(packPath));
      const resolveBaseBySha = (baseSha: string) => lookupBySha(idx, baseSha);
      for (const entry of idx.entries) {
        if (seen.has(entry.sha)) continue; // loose copy already counted
        const resolved = resolvePackObject(packBuf, entry.offset, resolveBaseBySha);
        if ("error" in resolved) continue;
        all.push({ sha: entry.sha, type: resolved.type, size: resolved.size });
        seen.add(entry.sha);
      }
    }
  }

  all.sort((a, b) => b.size - a.size || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  const top = all.slice(0, n);

  const shaToPath = new Map<string, string>();
  const headTreeSha = resolveHeadTreeSha(repoDir);
  if (typeof headTreeSha === "string") {
    const walked = walkTree(headTreeSha, makeTreeLoader(repoDir));
    if (!("error" in walked)) {
      for (const [path, sha] of Object.entries(walked)) {
        if (!shaToPath.has(sha)) {
          shaToPath.set(sha, path);
        }
      }
    }
  }

  return top.map((o) => ({
    sha: o.sha,
    type: o.type,
    size: o.size,
    path: shaToPath.get(o.sha) ?? null,
  }));
}
