import { bytesToHex, hexToBytes, isHex, type Hex } from "viem";

export type { Hex };

/** Standard base64 with padding (used for signatures, see ADR 005). */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict inverse of {@link toBase64}: rejects other alphabets and missing padding. */
export function fromBase64(text: string): Uint8Array {
  if (!BASE64.test(text)) throw new Error("not canonical base64");
  return new Uint8Array(Buffer.from(text, "base64"));
}

export function toHex(bytes: Uint8Array): Hex {
  return bytesToHex(bytes);
}

export function fromHex(hex: string): Uint8Array {
  if (!isHex(hex, { strict: true })) throw new Error("not hex");
  return hexToBytes(hex);
}

/** `0x` followed by exactly `2 * length` hex digits. */
export function isHexOfLength(value: unknown, length: number): value is Hex {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${2 * length}}$`).test(value);
}

export function isAddress(value: unknown): value is Hex {
  return isHexOfLength(value, 20);
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
