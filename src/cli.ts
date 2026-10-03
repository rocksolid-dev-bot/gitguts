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
import { storageCensus, type StorageCensus } from "./summary.js";

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
  lines.push(`loose objects      ${c.loose.count}   (${humanBytes(c.loose.bytes)})`);
  lines.push(`packs              ${c.packed.packs}   ${c.packed.count} objects`);
  return lines.join("\n");
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
  process.stdout.write(renderCensus(census) + "\n");
  return 0;
}

// Bin shim: runs `main` only when this file is the process entry point
// (never on import), then sets `process.exitCode` -- never
// `process.exit()`, which would cut off any buffered stdout write.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
