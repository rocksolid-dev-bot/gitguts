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
 * Exact 40-char resolution -- today's path, unchanged. Loose first, then
 * every pack found under `.git/objects/pack/`. Never throws: a SHA present
 * in neither storage, or an unreadable/unresolvable object, is a returned
 * `PackError`.
 */
function resolveExactSha(repoDir: string, sha: string): ResolvedObject | PackError {
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
 * Every loose SHA under `repoDir`'s `.git/objects/` whose full SHA starts
 * with `prefix` (already lowercased). Object dirs are named by the SHA's
 * first two hex characters, so a 1-char prefix must scan every dir whose
 * name starts with that character (up to 16 of them) instead of a single
 * exact dir.
 */
function looseShasWithPrefix(repoDir: string, prefix: string): string[] {
  const objectsDir = join(repoDir, ".git/objects");
  if (!existsSync(objectsDir)) {
    return [];
  }
  const matches: string[] = [];
  const dirPrefix = prefix.slice(0, 2);
  for (const dirName of readdirSync(objectsDir)) {
    if (dirName === "pack" || dirName === "info") {
      continue;
    }
    if (!dirName.startsWith(dirPrefix.slice(0, Math.min(dirPrefix.length, 2)))) {
      continue;
    }
    if (dirPrefix.length === 2 && dirName !== dirPrefix) {
      continue;
    }
    const dirPath = join(objectsDir, dirName);
    const rest = prefix.length > 2 ? prefix.slice(2) : "";
    for (const fileName of readdirSync(dirPath)) {
      if (fileName.startsWith(rest)) {
        matches.push(dirName + fileName);
      }
    }
  }
  return matches;
}

/** Every SHA in any discovered pack's idx table starting with `prefix`. */
function packedShasWithPrefix(packSources: PackSource[], prefix: string): string[] {
  const matches: string[] = [];
  for (const source of packSources) {
    for (const entry of source.idx.entries) {
      if (entry.sha.startsWith(prefix)) {
        matches.push(entry.sha);
      }
    }
  }
  return matches;
}

/**
 * Resolves a single object by SHA (or unambiguous SHA prefix, 1-40 hex
 * characters, case-insensitive) against `repoDir`'s object store. Exact
 * 40-char input keeps today's path untouched (`resolveExactSha`).
 * Shorter input scans loose storage and every pack's SHA table for every
 * object whose full SHA starts with the prefix: exactly one match
 * resolves it via `resolveExactSha`'s shape; two or more is a returned
 * `PackError` naming the prefix and the match count ("ambiguous"); zero
 * is today's "found in neither" message, unchanged. Non-hex input or
 * input over 40 characters is a returned `PackError` saying so. Never
 * throws.
 */
export function resolveObjectBySha(repoDir: string, sha: string): ResolvedObject | PackError {
  if (!/^[0-9a-fA-F]{1,40}$/.test(sha)) {
    return { error: `${sha} is not a hex object name` };
  }
  const lower = sha.toLowerCase();
  if (lower.length === 40) {
    return resolveExactSha(repoDir, lower);
  }

  const packSources = discoverPackSources(repoDir);
  if ("error" in packSources) {
    return packSources;
  }
  const looseMatches = looseShasWithPrefix(repoDir, lower);
  const packedMatches = packedShasWithPrefix(packSources, lower);
  const allMatches = Array.from(new Set([...looseMatches, ...packedMatches]));

  if (allMatches.length === 0) {
    return { error: `object ${sha} found in neither loose storage nor any pack under ${repoDir}` };
  }
  if (allMatches.length > 1) {
    return {
      error: `${sha} is ambiguous: ${allMatches.length} objects match this prefix under ${repoDir}`,
    };
  }
  return resolveExactSha(repoDir, allMatches[0]);
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
