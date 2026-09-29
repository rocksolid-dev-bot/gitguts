// Reader for the git pack `.idx` v2 format (see
// Documentation/gitformat-pack.txt). Read-only: this module never touches
// `.pack` bytes, only the index that describes them.
//
// Layout (all multi-byte fields big-endian):
//   4 bytes   magic       0xff744f63
//   4 bytes   version     2
//   256 * 4B  fanout      fanout[i] = count of objects whose first SHA byte <= i
//   N  * 20B  sha table   sorted ascending
//   N  * 4B   crc32 table
//   N  * 4B   offset table (31-bit offset; MSB set => index into overflow table)
//   M  * 8B   offset overflow table (only entries whose offset needs 64 bits)
//   20B       pack checksum
//   20B       idx checksum
//
// N = fanout[255] = total object count.

const MAGIC = 0xff744f63;
const HEADER_SIZE = 8;
const FANOUT_ENTRIES = 256;
const FANOUT_SIZE = FANOUT_ENTRIES * 4;
const SHA_SIZE = 20;
const CRC_SIZE = 4;
const OFFSET_SIZE = 4;
const OFFSET_OVERFLOW_FLAG = 0x80000000;

export interface IdxEntry {
  sha: string;
  offset: number;
  crc: number;
}

export interface Idx {
  version: number;
  objectCount: number;
  /** Entries in SHA-ascending order, matching the on-disk sha table. */
  entries: IdxEntry[];
}

export interface IdxError {
  error: string;
}

function toHex(buf: Uint8Array, start: number, len: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset + start, len).toString("hex");
}

export function readIdx(buf: Uint8Array): Idx | IdxError {
  if (buf.length < HEADER_SIZE + FANOUT_SIZE) {
    return { error: "buffer too short for .idx header and fanout table" };
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const magic = view.getUint32(0, false);
  if (magic !== MAGIC) {
    return {
      error: `bad magic: expected ${MAGIC.toString(16)}, got ${magic.toString(16)} (not a v2 .idx, or a loose/v1 file)`,
    };
  }

  const version = view.getUint32(4, false);
  if (version !== 2) {
    return { error: `unsupported .idx version: ${version} (only v2 is read)` };
  }

  const fanoutStart = HEADER_SIZE;
  const objectCount = view.getUint32(fanoutStart + 255 * 4, false);

  const shaTableStart = fanoutStart + FANOUT_SIZE;
  const crcTableStart = shaTableStart + objectCount * SHA_SIZE;
  const offsetTableStart = crcTableStart + objectCount * CRC_SIZE;
  const overflowTableStart = offsetTableStart + objectCount * OFFSET_SIZE;

  if (buf.length < overflowTableStart) {
    return {
      error: `buffer too short: expected at least ${overflowTableStart} bytes for ${objectCount} objects, got ${buf.length}`,
    };
  }

  const entries: IdxEntry[] = new Array(objectCount);

  for (let i = 0; i < objectCount; i++) {
    const sha = toHex(buf, shaTableStart + i * SHA_SIZE, SHA_SIZE);
    const crc = view.getUint32(crcTableStart + i * CRC_SIZE, false);
    const rawOffset = view.getUint32(offsetTableStart + i * OFFSET_SIZE, false);

    let offset: number;
    if ((rawOffset & OFFSET_OVERFLOW_FLAG) !== 0) {
      // Top bit set: the remaining 31 bits are an index into the 8-byte
      // overflow table, which holds the true (possibly >2GB) offset.
      // Unexercised by every fixture this project generates (packs stay
      // well under the 2 GB boundary) — see README limitations.
      const overflowIndex = rawOffset & 0x7fffffff;
      const overflowOffset = overflowTableStart + overflowIndex * 8;
      if (overflowOffset + 8 > buf.length) {
        return {
          error: `offset overflow table entry ${overflowIndex} out of bounds for object ${sha}`,
        };
      }
      const high = view.getUint32(overflowOffset, false);
      const low = view.getUint32(overflowOffset + 4, false);
      offset = high * 2 ** 32 + low;
    } else {
      offset = rawOffset;
    }

    entries[i] = { sha, offset, crc };
  }

  return { version, objectCount, entries };
}

/**
 * Binary search on the sorted sha table. Present objects resolve to their
 * entry; absent ones return `undefined` — never a throw.
 */
export function lookupBySha(idx: Idx, sha: string): IdxEntry | undefined {
  const target = sha.toLowerCase();
  const entries = idx.entries;
  let lo = 0;
  let hi = entries.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midSha = entries[mid].sha;
    if (midSha === target) {
      return entries[mid];
    }
    if (midSha < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return undefined;
}
