#!/usr/bin/env node
// Imports the built package from outside the repo source tree, exactly as a
// real consumer would after npm install, to prove the dist build is usable.
import { readLooseObject } from "../dist/index.js";
import { deflateSync } from "node:zlib";

const payload = Buffer.from("hello\n");
const header = `blob ${payload.length}\0`;
const raw = Buffer.concat([Buffer.from(header), payload]);
const compressed = deflateSync(raw);

const result = readLooseObject(compressed);

if ("error" in result) {
  console.error("usage-probe FAILED:", result.error);
  process.exit(1);
}

console.log("usage-probe ok:", JSON.stringify(result.type), result.size);
process.exit(0);
