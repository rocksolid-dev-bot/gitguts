// CLI entry point: ties the readers together into the `gitguts <repo>`
// output BRIEF.md promises. This file is the one place in the project
// allowed to touch stdout/exit codes; every renderer stays a pure
// function so the test suite asserts on return values, never captured
// stdout.
//
// Invariant this file must keep (enforced by scripts/invariants.sh and the
// never-raise convention everywhere else in src/): a missing or
// non-repo path is a returned non-zero exit code with a one-line reason,
// never an exception. `main` never calls `process.exit()` either -- only
// the bin shim at the bottom sets `process.exitCode`, so `main` stays
// testable as a plain function.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  storageCensus,
  deltaStats,
  largestObjects,
  type StorageCensus,
  type DeltaStats,
  type LargestObject,
} from "./summary.js";

/** Every label column in BRIEF.md's sample block lines up at this width --
 * measured off the sample itself ("loose objects" + 6 spaces = 19,
 * "packs" + 14 spaces = 19, "  delta chains" + 5 spaces = 19, "largest
 * blobs" + 6 spaces = 19), never eyeballed per line. */
const LABEL_WIDTH = 19;

/** Formats a byte count the way `git count-objects -v` reads, human-scale:
 * whole bytes under 1 KB, one decimal place from 1 KB up. Never `NaN` --
 * `0` renders as `0 B`. */
function humanBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Renders the loose/packed census section of BRIEF.md's sample block.
 * Pure: returns the text, prints nothing. This is the whole test surface
 * for this renderer -- stdout is not asserted on anywhere in the suite.
 *
 * `StorageCensus.packed` carries no byte total (only `count` and `packs`,
 * read off `git count-objects -v`'s own fields), so the packs line reports
 * object count only -- never a guessed or recomputed byte figure.
 */
export function renderCensus(c: StorageCensus): string {
  const lines: string[] = [];
  lines.push(
    `${"loose objects".padEnd(LABEL_WIDTH)}${c.loose.count}   (${humanBytes(c.loose.bytes)})`
  );
  lines.push(`${"packs".padEnd(LABEL_WIDTH)}${c.packed.packs}   ${c.packed.count} objects`);
  return lines.join("\n");
}

/**
 * Renders the delta-chain histogram as BRIEF.md's `  delta chains` line:
 * the max chain depth reached and how many objects out of the pack(s)
 * were deltified at all (`objects - histogram[0]`, never `objects` alone
 * -- the non-delta objects are not deltified). A repo with no packs gets
 * the identical shape with zeros -- `deltaStats`'s own no-pack guard
 * already keeps `meanDepth` out of `NaN`, so there is nothing here that
 * can print `NaN`: "no packs" and "no deltas" render the same honest
 * line, never a blank one.
 */
export function renderDeltaChains(d: DeltaStats): string {
  const deltified = d.objects - (d.histogram[0] ?? 0);
  return `${"  delta chains".padEnd(LABEL_WIDTH)}max depth ${d.maxDepth}, ${deltified} deltified`;
}

/**
 * Renders the top-N largest-objects ranking as BRIEF.md's `largest blobs`
 * block: one row per object, SHA abbreviated to 7 hex characters (git's
 * own default abbreviation length), size human-readable, and the path as
 * resolved by `largestObjects` itself -- `-` when the object is not
 * reachable from HEAD, which is a value read off the walk, never
 * "unknown" and never guessed. Only the first row carries the label;
 * continuation rows indent to the same column so the block reads as one
 * ranking, not N separate sections.
 */
export function renderLargestObjects(objs: LargestObject[]): string {
  return objs
    .map((o, i) => {
      const label = i === 0 ? "largest blobs".padEnd(LABEL_WIDTH) : " ".repeat(LABEL_WIDTH);
      const path = o.path ?? "-";
      return `${label}${o.sha.slice(0, 7)}  ${humanBytes(o.size)}  ${path}`;
    })
    .join("\n");
}

/**
 * `argv[2] ?? "."` is the repo path (so `main(process.argv)` on `node
 * cli.js <path>` and `main(process.argv)` on `node cli.js` both work). A
 * missing or non-`.git` path returns a non-zero code and writes a
 * one-line reason to stdout -- a returned value, never an exception.
 */
export function main(argv: string[]): number {
  const repoPath = argv[2] ?? ".";
  const gitDir = join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    process.stdout.write(`gitguts: ${repoPath} is not a git repository (no .git found)\n`);
    return 1;
  }
  const census = storageCensus(gitDir);
  const delta = deltaStats(gitDir);
  const top = largestObjects(repoPath, 3);
  const sections = [renderCensus(census), renderDeltaChains(delta)];
  if (top.length > 0) {
    sections.push(renderLargestObjects(top));
  }
  process.stdout.write(sections.join("\n") + "\n");
  return 0;
}

// Bin shim: runs `main` only when this file is the process entry point
// (never on import), then sets `process.exitCode` -- never
// `process.exit()`, which would cut off any buffered stdout write.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
