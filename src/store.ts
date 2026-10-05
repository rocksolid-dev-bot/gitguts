// Ties the loose, idx and pack readers together into a single tree loader:
// a `load(sha) => TreeEntry[] | PackError` callback shaped exactly for
// `walkTree` (see tree.ts), that resolves a tree SHA whether it lives as a
// loose object or inside a pack. Read-only, no `git` subprocess -- that
// stays in `test/` as the oracle.
//
// Resolution order: loose first (the common case for recently-written
// objects and the only case `nested`/`basic` exercise), then every pack
// found under `.git/objects/pack/` in turn. A SHA found in neither is a
// returned `PackError`, never raised.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readLooseObject } from "./loose.js";
import { readIdx, lookupBySha, type Idx } from "./idx.js";
import { resolvePackObject } from "./pack.js";
import { parseTree, type TreeEntry } from "./tree.js";
import type { PackError, PackObjectType } from "./pack.js";

interface PackSource {
  idx: Idx;
  packBuf: Uint8Array;
}

function loadLooseTree(repoDir: string, sha: string): TreeEntry[] | PackError | undefined {
  const path = join(repoDir, ".git/objects", sha.slice(0, 2), sha.slice(2));
  if (!existsSync(path)) {
    return undefined;
  }
  const obj = readLooseObject(new Uint8Array(readFileSync(path)));
  if ("error" in obj) {
    return { error: `loose object ${sha} unreadable: ${obj.error}` };
  }
  if (obj.type !== "tree") {
    return { error: `loose object ${sha} is type ${obj.type}, not tree` };
  }
  return parseTree(obj.payload);
}

function discoverPackSources(repoDir: string): PackSource[] | PackError {
  const packDir = join(repoDir, ".git/objects/pack");
  if (!existsSync(packDir)) {
    return [];
  }
  const files = readdirSync(packDir);
  const idxFiles = files.filter((f) => f.endsWith(".idx"));
  const sources: PackSource[] = [];
  for (const idxFile of idxFiles) {
    const idxPath = join(packDir, idxFile);
    const packFile = idxFile.slice(0, -".idx".length) + ".pack";
    const packPath = join(packDir, packFile);
    if (!existsSync(packPath)) {
      return { error: `no matching .pack for ${idxFile} in ${packDir}` };
    }
    const idxResult = readIdx(new Uint8Array(readFileSync(idxPath)));
    if ("error" in idxResult) {
      return { error: `readIdx failed for ${idxFile}: ${idxResult.error}` };
    }
    sources.push({ idx: idxResult, packBuf: new Uint8Array(readFileSync(packPath)) });
  }
  return sources;
}

function loadPackedTree(sources: PackSource[], sha: string): TreeEntry[] | PackError | undefined {
  for (const source of sources) {
    const entry = lookupBySha(source.idx, sha);
    if (!entry) {
      continue;
    }
    // REF_DELTA bases are resolved by SHA within the same pack only -- every
    // fixture this project generates uses OFS_DELTA exclusively (see
    // README's Limitations), so a same-pack SHA lookup is sufficient here.
    const resolveBaseBySha = (baseSha: string) => lookupBySha(source.idx, baseSha);
    const resolved = resolvePackObject(source.packBuf, entry.offset, resolveBaseBySha);
    if ("error" in resolved) {
      return { error: `pack object ${sha} unresolvable: ${resolved.error}` };
    }
    if (resolved.type !== "tree") {
      return { error: `pack object ${sha} is type ${resolved.type}, not tree` };
    }
    return parseTree(resolved.payload);
  }
  return undefined;
}

export interface ResolvedObject {
  /** Logical object type, read off the loose header or the pack header --
   * the same four values either storage can hold. */
  type: PackObjectType;
  /** Logical (uncompressed) byte size -- what `git cat-file -s` reports,
   * never the on-disk compressed size. */
  size: number;
  storage: "loose" | "packed";
  /** Delta chain depth walked to resolve this object: 0 for loose and for
   * a non-delta packed object. */
  depth: number;
}

/**
 * Resolves a single object by SHA against `repoDir`'s object store, loose
 * first and then every pack found under `.git/objects/pack/` -- the same
 * resolution order `makeTreeLoader` uses. Never throws: a SHA present in
 * neither storage, or an unreadable/unresolvable object, is a returned
 * `PackError`.
 */
export function resolveObjectBySha(repoDir: string, sha: string): ResolvedObject | PackError {
  const loosePath = join(repoDir, ".git/objects", sha.slice(0, 2), sha.slice(2));
  if (existsSync(loosePath)) {
    const obj = readLooseObject(new Uint8Array(readFileSync(loosePath)));
    if ("error" in obj) {
      return { error: `loose object ${sha} unreadable: ${obj.error}` };
    }
    return { type: obj.type, size: obj.size, storage: "loose", depth: 0 };
  }
  const packSources = discoverPackSources(repoDir);
  if ("error" in packSources) {
    return packSources;
  }
  for (const source of packSources) {
    const entry = lookupBySha(source.idx, sha);
    if (!entry) {
      continue;
    }
    const resolveBaseBySha = (baseSha: string) => lookupBySha(source.idx, baseSha);
    const resolved = resolvePackObject(source.packBuf, entry.offset, resolveBaseBySha);
    if ("error" in resolved) {
      return { error: `pack object ${sha} unresolvable: ${resolved.error}` };
    }
    return { type: resolved.type, size: resolved.size, storage: "packed", depth: resolved.depth };
  }
  return { error: `object ${sha} found in neither loose storage nor any pack under ${repoDir}` };
}

/**
 * Builds a `load` callback for `walkTree` that resolves a tree SHA against
 * `repoDir`'s object store, loose first and then every pack found under
 * `.git/objects/pack/`. A SHA present in neither storage is a returned
 * `PackError`, never raised.
 */
export function makeTreeLoader(
  repoDir: string
): (sha: string) => TreeEntry[] | PackError {
  const packSources = discoverPackSources(repoDir);
  return (sha: string): TreeEntry[] | PackError => {
    const loose = loadLooseTree(repoDir, sha);
    if (loose !== undefined) {
      return loose;
    }
    if ("error" in packSources) {
      return packSources;
    }
    const packed = loadPackedTree(packSources, sha);
    if (packed !== undefined) {
      return packed;
    }
    return { error: `tree ${sha} found in neither loose storage nor any pack under ${repoDir}` };
  };
}
