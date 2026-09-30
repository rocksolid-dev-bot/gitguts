// Reader for pack object headers and OFS_DELTA/REF_DELTA reconstruction (see
// Documentation/gitformat-pack.txt). Read-only: never writes to `.pack`,
// never runs `git` as a subprocess — that stays in `test/` as the oracle.
//
// A pack object at a given offset starts with a variable-length header that
// differs from the loose-object header in every particular:
//
//   byte 0:      bit 7 = continuation, bits 6-4 = type, bits 3-0 = size bits
//   byte 1..N:   bit 7 = continuation, bits 6-0 = next 7 size bits
//   size is little-endian across continuation bytes: shift 4, then 11, 18, …
//   (the first byte contributes 4 bits, every byte after contributes 7)
//
// type 1=commit 2=tree 3=blob 4=tag 6=OFS_DELTA 7=REF_DELTA; 5 is unused and
// is a returned error here, never a crash.
//
// OFS_DELTA carries a base-offset varint immediately after the type/size
// header, with its own distinct encoding: big-endian across continuation
// bytes (not little-endian like the size above) and +1-biased on every
// continuation:
//
//   o = b0 & 0x7f
//   per further continuation byte: o = ((o + 1) << 7) | (b & 0x7f)
//   base offset = thisObjectOffset - o
//
// Dropping the `+1` bias still lands on a plausible-looking offset for a
// two-byte-or-shorter case and silently reconstructs garbage from the wrong
// base — the single easiest thing to get wrong in this format.
//
// REF_DELTA carries a raw 20-byte base SHA-1 instead of an offset varint.
//
// After the header (and, for deltas, the base reference), the rest of the
// object is a zlib stream. For non-delta objects it inflates directly to the
// object payload. For delta objects it inflates to a delta stream: a
// source-size varint, a target-size varint (both a third encoding again —
// plain unsigned LEB128: little-endian 7-bit groups, no bias, no 4-bit first
// nibble), then copy/insert instructions until the stream ends.

import { inflateSync } from "node:zlib";

export type PackObjectType = "commit" | "tree" | "blob" | "tag";

const TYPE_NAMES: Record<number, PackObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;
const REF_DELTA_SHA_BYTES = 20;

// Recursion guard: nothing in this project's fixtures produces a chain
// longer than 1, but a corrupt or adversarial pack could cycle offsets into
// each other. A returned error beats a stack overflow.
const MAX_CHAIN_DEPTH = 50;

export interface PackObjectHeader {
  /** Raw type code as stored in the header: 1,2,3,4,6 or 7. */
  typeCode: number;
  /**
   * Resolved type name for non-delta objects; "ofs-delta"/"ref-delta" for
   * the two delta kinds, which are not real git object types themselves.
   */
  type: PackObjectType | "ofs-delta" | "ref-delta";
  /** The header's declared size field. For delta objects this is the size
   * of the delta stream once inflated (source+target varints plus
   * instructions), never the reconstructed object's final size — the
   * `git verify-pack -v` size column for a delta object measures the same
   * thing, which is why it disagrees with `git cat-file -s`. */
  size: number;
  /** Absolute offset in the pack where the header (and, for OFS_DELTA, the
   * base-offset varint / for REF_DELTA, the base SHA) ends and the zlib
   * stream begins. */
  dataOffset: number;
  /** OFS_DELTA only: the resolved absolute offset of the base object. */
  baseOffset?: number;
  /** REF_DELTA only: the 20-byte base object SHA-1, lowercase hex. */
  baseSha?: string;
}

export interface PackError {
  error: string;
}

export function readPackObjectHeader(
  buf: Uint8Array,
  offset: number
): PackObjectHeader | PackError {
  if (offset < 0 || offset >= buf.length) {
    return { error: `offset ${offset} out of bounds (buffer length ${buf.length})` };
  }

  let pos = offset;
  const first = buf[pos];
  pos++;

  const typeCode = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let more = (first & 0x80) !== 0;

  while (more) {
    if (pos >= buf.length) {
      return { error: `truncated object header at offset ${offset}` };
    }
    const b = buf[pos];
    pos++;
    size |= (b & 0x7f) << shift;
    shift += 7;
    more = (b & 0x80) !== 0;
  }

  if (typeCode === 0 || typeCode === 5) {
    return { error: `unused/invalid object type code ${typeCode} at offset ${offset}` };
  }

  if (typeCode === TYPE_OFS_DELTA) {
    if (pos >= buf.length) {
      return { error: `truncated OFS_DELTA base-offset varint at offset ${offset}` };
    }
    let b = buf[pos];
    pos++;
    let o = b & 0x7f;
    while ((b & 0x80) !== 0) {
      if (pos >= buf.length) {
        return { error: `truncated OFS_DELTA base-offset varint at offset ${offset}` };
      }
      b = buf[pos];
      pos++;
      o = ((o + 1) << 7) | (b & 0x7f);
    }
    const baseOffset = offset - o;
    if (baseOffset < 0) {
      return {
        error: `OFS_DELTA base offset ${baseOffset} is negative (relative ${o} from ${offset})`,
      };
    }
    return {
      typeCode,
      type: "ofs-delta",
      size,
      dataOffset: pos,
      baseOffset,
    };
  }

  if (typeCode === TYPE_REF_DELTA) {
    if (pos + REF_DELTA_SHA_BYTES > buf.length) {
      return { error: `truncated REF_DELTA base SHA at offset ${offset}` };
    }
    const baseSha = Buffer.from(
      buf.buffer,
      buf.byteOffset + pos,
      REF_DELTA_SHA_BYTES
    ).toString("hex");
    pos += REF_DELTA_SHA_BYTES;
    return {
      typeCode,
      type: "ref-delta",
      size,
      dataOffset: pos,
      baseSha,
    };
  }

  const type = TYPE_NAMES[typeCode];
  if (!type) {
    return { error: `unknown object type code ${typeCode} at offset ${offset}` };
  }

  return { typeCode, type, size, dataOffset: pos };
}

export type DeltaInstruction =
  | { kind: "copy"; offset: number; length: number }
  | { kind: "insert"; bytes: Uint8Array };

export interface DeltaStream {
  srcSize: number;
  tgtSize: number;
  instructions: DeltaInstruction[];
  copyCount: number;
  insertCount: number;
  copyBytes: number;
  insertBytes: number;
}

// Plain unsigned LEB128: little-endian 7-bit groups, no bias. Distinct from
// both the object header's size encoding (which reserves 4 bits in the
// first byte) and OFS_DELTA's base-offset encoding (big-endian, +1-biased).
function readDeltaSizeVarint(
  buf: Uint8Array,
  pos: number
): { value: number; next: number } | PackError {
  let value = 0;
  let shift = 0;
  let p = pos;
  while (true) {
    if (p >= buf.length) {
      return { error: `truncated delta size varint at offset ${pos}` };
    }
    const b = buf[p];
    p++;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) {
      break;
    }
  }
  return { value, next: p };
}

/**
 * Parses an inflated delta stream (source-size varint, target-size varint,
 * then copy/insert instructions) into a structured, applyable form plus the
 * instruction-mix counts the oracle asserts directly.
 */
export function parseDeltaStream(inflated: Uint8Array): DeltaStream | PackError {
  const src = readDeltaSizeVarint(inflated, 0);
  if ("error" in src) return src;
  const tgt = readDeltaSizeVarint(inflated, src.next);
  if ("error" in tgt) return tgt;

  const instructions: DeltaInstruction[] = [];
  let copyCount = 0;
  let insertCount = 0;
  let copyBytes = 0;
  let insertBytes = 0;

  let pos = tgt.next;
  while (pos < inflated.length) {
    const opcode = inflated[pos];
    pos++;

    if ((opcode & 0x80) !== 0) {
      // Copy-from-base: bits 0-3 select which of 4 offset bytes are
      // present (LSB first), bits 4-6 select which of 3 length bytes.
      let copyOffset = 0;
      let shift = 0;
      for (let i = 0; i < 4; i++) {
        if ((opcode & (1 << i)) !== 0) {
          if (pos >= inflated.length) {
            return { error: "truncated copy instruction (offset byte)" };
          }
          copyOffset |= inflated[pos] << shift;
          pos++;
        }
        shift += 8;
      }

      let length = 0;
      shift = 0;
      for (let i = 0; i < 3; i++) {
        if ((opcode & (1 << (4 + i))) !== 0) {
          if (pos >= inflated.length) {
            return { error: "truncated copy instruction (length byte)" };
          }
          length |= inflated[pos] << shift;
          pos++;
        }
        shift += 8;
      }
      if (length === 0) {
        length = 0x10000;
      }

      instructions.push({ kind: "copy", offset: copyOffset, length });
      copyCount++;
      copyBytes += length;
    } else {
      // Insert literal: low 7 bits are the byte count. 0 is a reserved
      // opcode, never a valid zero-length insert.
      const count = opcode & 0x7f;
      if (count === 0) {
        return { error: `reserved insert opcode (0) at delta stream offset ${pos - 1}` };
      }
      if (pos + count > inflated.length) {
        return { error: "truncated insert instruction (literal bytes)" };
      }
      const bytes = inflated.subarray(pos, pos + count);
      pos += count;

      instructions.push({ kind: "insert", bytes });
      insertCount++;
      insertBytes += count;
    }
  }

  return {
    srcSize: src.value,
    tgtSize: tgt.value,
    instructions,
    copyCount,
    insertCount,
    copyBytes,
    insertBytes,
  };
}

/** Applies a parsed delta stream against its resolved base payload. */
export function applyDelta(
  base: Uint8Array,
  delta: DeltaStream
): Uint8Array | PackError {
  if (base.length !== delta.srcSize) {
    return {
      error: `base length ${base.length} does not match delta srcSize ${delta.srcSize}`,
    };
  }

  const out = Buffer.alloc(delta.tgtSize);
  let outPos = 0;

  for (const instr of delta.instructions) {
    if (instr.kind === "copy") {
      const end = instr.offset + instr.length;
      if (end > base.length) {
        return {
          error: `copy instruction reads [${instr.offset}, ${end}) past base length ${base.length}`,
        };
      }
      if (outPos + instr.length > out.length) {
        return { error: "copy instruction overflows target buffer" };
      }
      out.set(base.subarray(instr.offset, end), outPos);
      outPos += instr.length;
    } else {
      if (outPos + instr.bytes.length > out.length) {
        return { error: "insert instruction overflows target buffer" };
      }
      out.set(instr.bytes, outPos);
      outPos += instr.bytes.length;
    }
  }

  if (outPos !== delta.tgtSize) {
    return {
      error: `reconstructed ${outPos} bytes but delta declared tgtSize ${delta.tgtSize}`,
    };
  }

  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export interface ResolvedPackObject {
  type: PackObjectType;
  size: number;
  payload: Uint8Array;
  /** Delta chain depth walked to produce this object: 0 for a non-delta
   * object, 1 for a delta resolved directly against a non-delta base, and
   * so on for nested deltas. */
  depth: number;
}

export type ResolveBaseBySha = (sha: string) => PackObjectHeaderAt | undefined;

/** Pairs a header with the absolute offset it was read from, needed for
 * REF_DELTA resolution where the caller must look the base SHA up in the
 * `.idx` to find where in the pack it lives. */
export interface PackObjectHeaderAt {
  offset: number;
}

/**
 * Resolves the object at `offset` to its full reconstructed bytes,
 * recursing through as many OFS_DELTA/REF_DELTA links as the chain
 * contains. `resolveBaseBySha` is only consulted for REF_DELTA bases (by
 * offset, OFS_DELTA needs none of it) and may be omitted when the caller
 * knows no REF_DELTA objects are present.
 */
export function resolvePackObject(
  buf: Uint8Array,
  offset: number,
  resolveBaseBySha?: ResolveBaseBySha
): ResolvedPackObject | PackError {
  return resolveAt(buf, offset, resolveBaseBySha, 0);
}

function resolveAt(
  buf: Uint8Array,
  offset: number,
  resolveBaseBySha: ResolveBaseBySha | undefined,
  recursionDepth: number
): ResolvedPackObject | PackError {
  if (recursionDepth > MAX_CHAIN_DEPTH) {
    return { error: `delta chain exceeds max depth ${MAX_CHAIN_DEPTH} at offset ${offset}` };
  }

  const header = readPackObjectHeader(buf, offset);
  if ("error" in header) return header;

  if (header.type === "commit" || header.type === "tree" || header.type === "blob" || header.type === "tag") {
    const stream = buf.subarray(header.dataOffset);
    let payload: Buffer;
    try {
      payload = inflateSync(stream);
    } catch {
      return { error: `not a valid zlib stream at data offset ${header.dataOffset} (object at ${offset})` };
    }
    if (payload.length !== header.size) {
      return {
        error: `declared size ${header.size} does not match inflated length ${payload.length} at offset ${offset}`,
      };
    }
    // A non-delta object has chain depth 0 regardless of how deep the
    // recursion that reached it went — depth counts delta links walked to
    // produce *this* resolved object, not recursion frames.
    return { type: header.type, size: header.size, payload: new Uint8Array(payload), depth: 0 };
  }

  // Delta object: inflate to get the delta stream, resolve the base, apply.
  const stream = buf.subarray(header.dataOffset);
  let inflated: Buffer;
  try {
    inflated = inflateSync(stream);
  } catch {
    return { error: `not a valid zlib stream at data offset ${header.dataOffset} (object at ${offset})` };
  }
  if (inflated.length !== header.size) {
    return {
      error: `declared size ${header.size} does not match inflated delta-stream length ${inflated.length} at offset ${offset}`,
    };
  }

  const delta = parseDeltaStream(new Uint8Array(inflated));
  if ("error" in delta) return delta;

  let baseOffset: number;
  if (header.type === "ofs-delta") {
    baseOffset = header.baseOffset!;
  } else {
    if (!resolveBaseBySha) {
      return { error: `REF_DELTA at offset ${offset} needs resolveBaseBySha, none was given` };
    }
    const found = resolveBaseBySha(header.baseSha!);
    if (!found) {
      return { error: `REF_DELTA base SHA ${header.baseSha} not found` };
    }
    baseOffset = found.offset;
  }

  const base = resolveAt(buf, baseOffset, resolveBaseBySha, recursionDepth + 1);
  if ("error" in base) return base;

  const payload = applyDelta(base.payload, delta);
  if ("error" in payload) return payload;

  return {
    type: base.type,
    size: delta.tgtSize,
    payload,
    depth: base.depth + 1,
  };
}
