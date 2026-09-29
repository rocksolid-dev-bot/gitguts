import { inflateSync } from "node:zlib";

export type LooseObjectType = "commit" | "tree" | "blob" | "tag";

export interface LooseObject {
  type: LooseObjectType;
  size: number;
  payload: Uint8Array;
}

export interface LooseObjectError {
  error: string;
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  "commit",
  "tree",
  "blob",
  "tag",
]);

export function readLooseObject(
  bytes: Uint8Array
): LooseObject | LooseObjectError {
  let inflated: Buffer;
  try {
    inflated = inflateSync(bytes);
  } catch {
    return { error: "not a valid zlib stream" };
  }

  const nulIndex = inflated.indexOf(0);
  if (nulIndex === -1) {
    return { error: "no NUL byte found in header" };
  }

  const header = inflated.subarray(0, nulIndex).toString("utf8");
  const spaceIndex = header.indexOf(" ");
  if (spaceIndex === -1) {
    return { error: "malformed header: missing space" };
  }

  const type = header.slice(0, spaceIndex);
  const lenStr = header.slice(spaceIndex + 1);

  if (!VALID_TYPES.has(type)) {
    return { error: `unknown object type: ${type}` };
  }

  const declaredLen = Number(lenStr);
  if (!Number.isInteger(declaredLen) || declaredLen < 0) {
    return { error: `malformed length: ${lenStr}` };
  }

  const payload = inflated.subarray(nulIndex + 1);

  if (payload.length !== declaredLen) {
    return {
      error: `declared length ${declaredLen} does not match payload length ${payload.length}`,
    };
  }

  return {
    type: type as LooseObjectType,
    size: declaredLen,
    payload: new Uint8Array(payload),
  };
}
