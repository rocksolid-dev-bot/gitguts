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
import { readIdx } from "./idx.js";

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
