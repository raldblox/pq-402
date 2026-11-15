import {
  generateSealKeys,
  open,
  QoreSealError,
  seal,
  sealKeysFromSeed,
  type SealKeyPair,
} from "@qorechain/qoreseal";
import { hexToBytes, type Hex } from "viem";
import { concatBytes, isAddress, utf8 } from "./bytes.js";
import { PROTOCOL_VERSION, REQUEST_PURPOSE, RESPONSE_PURPOSE } from "./constants.js";
import { ErrorCode, Pq402Error } from "./errors.js";

export { generateSealKeys, sealKeysFromSeed, type SealKeyPair };

/** `extensions["pq402-sealing"].info` of a `402` (docs/spec.md section 8.1). */
export interface SealingInfo {
  version: typeof PROTOCOL_VERSION;
  /** QoreChain chain id fed to QoreSeal's key derivation, e.g. `qorechain-diana`. */
  chainId: string;
  /** Account whose registered ML-KEM-1024 key seals requests and whose ML-DSA-87 key signs receipts. */
  gateway: Hex;
  mode: "mlkem";
  request: "required" | "optional";
  response: "sealed";
}

/** JSON Schema of {@link SealingInfo}, sent with the declaration as x402 requires. */
export const sealingInfoSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["version", "chainId", "gateway", "mode", "request", "response"],
  additionalProperties: false,
  properties: {
    version: { const: PROTOCOL_VERSION },
    chainId: { type: "string", minLength: 1 },
    gateway: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    mode: { const: "mlkem" },
    request: { enum: ["required", "optional"] },
    response: { const: "sealed" },
  },
} as const;

export function sealingDeclaration(info: SealingInfo): {
  info: SealingInfo;
  schema: typeof sealingInfoSchema;
} {
  return { info, schema: sealingInfoSchema };
}

/** Reads the `info` of a declaration or of an echoed extension; `undefined` if malformed. */
export function parseSealingInfo(value: unknown): SealingInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as { info?: unknown }).info ?? value;
  if (typeof raw !== "object" || raw === null) return undefined;
  const i = raw as Record<string, unknown>;
  if (i.version !== PROTOCOL_VERSION || typeof i.chainId !== "string" || i.chainId.length === 0)
    return undefined;
  if (!isAddress(i.gateway) || i.mode !== "mlkem" || i.response !== "sealed") return undefined;
  if (i.request !== "required" && i.request !== "optional") return undefined;
  return {
    version: PROTOCOL_VERSION,
    chainId: i.chainId,
    gateway: i.gateway,
    mode: "mlkem",
    request: i.request,
    response: "sealed",
  };
}

export function requestAad(method: string, target: string, contentType: string): Uint8Array {
  return utf8(`${method.toUpperCase()} ${target}\n${contentType}`);
}

export function responseAad(requestHash: Hex, contentType: string): Uint8Array {
  return concatBytes(hexToBytes(requestHash), utf8(contentType));
}

function sealingFailure(err: unknown): Pq402Error {
  const detail = err instanceof QoreSealError ? err.code : err instanceof Error ? err.message : String(err);
  return new Pq402Error(ErrorCode.Sealing, `sealing failed: ${detail}`);
}

export interface SealRequestArgs {
  chainId: string;
  /** The gateway's ML-KEM-1024 key, read from the chain's KEM registry. */
  gatewayKey: Uint8Array;
  method: string;
  target: string;
  contentType: string;
  body: Uint8Array;
}

/** Seal a request body to the gateway. The result is the body to send. */
export function sealRequest(a: SealRequestArgs): Uint8Array {
  try {
    return seal({
      chainId: a.chainId,
      purpose: REQUEST_PURPOSE,
      mode: "mlkem",
      recipients: [{ mlkemPublicKey: a.gatewayKey }],
      plaintext: a.body,
      aad: requestAad(a.method, a.target, a.contentType),
    });
  } catch (err) {
    throw sealingFailure(err);
  }
}

export interface OpenRequestArgs {
  chainId: string;
  keys: SealKeyPair;
  method: string;
  target: string;
  contentType: string;
  envelope: Uint8Array;
}

export function openRequest(a: OpenRequestArgs): Uint8Array {
  try {
    return open({
      chainId: a.chainId,
      purpose: REQUEST_PURPOSE,
      envelope: a.envelope,
      keys: a.keys,
      aad: requestAad(a.method, a.target, a.contentType),
    });
  } catch (err) {
    throw sealingFailure(err);
  }
}

export interface SealResponseArgs {
  chainId: string;
  /** The payer's ML-KEM-1024 key, read from the chain's KEM registry. */
  payerKey: Uint8Array;
  requestHash: Hex;
  contentType: string;
  body: Uint8Array;
}

export function sealResponse(a: SealResponseArgs): Uint8Array {
  try {
    return seal({
      chainId: a.chainId,
      purpose: RESPONSE_PURPOSE,
      mode: "mlkem",
      recipients: [{ mlkemPublicKey: a.payerKey }],
      plaintext: a.body,
      aad: responseAad(a.requestHash, a.contentType),
    });
  } catch (err) {
    throw sealingFailure(err);
  }
}

export interface OpenResponseArgs {
  chainId: string;
  keys: SealKeyPair;
  requestHash: Hex;
  contentType: string;
  envelope: Uint8Array;
}

export function openResponse(a: OpenResponseArgs): Uint8Array {
  try {
    return open({
      chainId: a.chainId,
      purpose: RESPONSE_PURPOSE,
      envelope: a.envelope,
      keys: a.keys,
      aad: responseAad(a.requestHash, a.contentType),
    });
  } catch (err) {
    throw sealingFailure(err);
  }
}
