import type { PaymentRequirements } from "@x402/core/types";
import type { Hex } from "viem";
import { fromBase64, isAddress, isHexOfLength, toBase64, toHex } from "./bytes.js";
import { ML_DSA_87_SIGNATURE_LENGTH, PROTOCOL_VERSION } from "./constants.js";
import { paymentMessage, type Payment } from "./encoding.js";
import { mldsaSign } from "./mldsa.js";

/** `PaymentPayload.payload` of the `pq-escrow` scheme (docs/spec.md section 4). */
export interface PqEscrowPayload {
  payer: Hex;
  nonce: Hex;
  validAfter: string;
  validBefore: string;
  requestHash: Hex;
  /** Base64 of the 4627-byte ML-DSA-87 signature. */
  signature: string;
}

/** `PaymentRequirements.extra` of the `pq-escrow` scheme. */
export interface PqEscrowExtra {
  escrow: Hex;
  version: typeof PROTOCOL_VERSION;
}

const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

/** EVM chain id of an `eip155:<id>` network. */
export function evmChainIdOf(network: string): bigint {
  const m = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (!m?.[1]) throw new Error(`not an eip155 network: ${network}`);
  return BigInt(m[1]);
}

export function parseExtra(extra: unknown): PqEscrowExtra | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const e = extra as Record<string, unknown>;
  if (e.version !== PROTOCOL_VERSION || !isAddress(e.escrow)) return undefined;
  return { escrow: e.escrow, version: PROTOCOL_VERSION };
}

/** Type-checks an untrusted payload. Returns `undefined` if anything is malformed. */
export function parsePayload(payload: unknown): PqEscrowPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (!isAddress(p.payer) || !isHexOfLength(p.nonce, 32) || !isHexOfLength(p.requestHash, 32))
    return undefined;
  if (typeof p.validAfter !== "string" || !DECIMAL.test(p.validAfter)) return undefined;
  if (typeof p.validBefore !== "string" || !DECIMAL.test(p.validBefore)) return undefined;
  if (BigInt(p.validAfter) >= 1n << 64n || BigInt(p.validBefore) >= 1n << 64n) return undefined;
  if (typeof p.signature !== "string") return undefined;
  try {
    if (fromBase64(p.signature).length !== ML_DSA_87_SIGNATURE_LENGTH) return undefined;
  } catch {
    return undefined;
  }
  return {
    payer: p.payer,
    nonce: p.nonce,
    validAfter: p.validAfter,
    validBefore: p.validBefore,
    requestHash: p.requestHash,
    signature: p.signature,
  };
}

/** The payment a payload authorises against the requirements it accepted. */
export function paymentOf(requirements: PaymentRequirements, payload: PqEscrowPayload): Payment {
  const extra = parseExtra(requirements.extra);
  if (!extra) throw new Error("requirements are not pq-escrow v1");
  if (!isAddress(requirements.payTo) || !isAddress(requirements.asset)) {
    throw new Error("payTo and asset must be addresses");
  }
  if (!DECIMAL.test(requirements.amount)) throw new Error("amount must be a decimal integer");
  return {
    chainId: evmChainIdOf(requirements.network),
    escrow: extra.escrow,
    payer: payload.payer,
    payTo: requirements.payTo,
    asset: requirements.asset,
    amount: BigInt(requirements.amount),
    nonce: payload.nonce,
    validAfter: BigInt(payload.validAfter),
    validBefore: BigInt(payload.validBefore),
    requestHash: payload.requestHash,
  };
}

export interface CreatePayloadArgs {
  requirements: PaymentRequirements;
  payer: Hex;
  /** The payer's ML-DSA-87 secret key; must match the key registered on chain. */
  secretKey: Uint8Array;
  requestHash: Hex;
  /** Current unix time in seconds. */
  now: number;
  /** 32 bytes; random when omitted. */
  nonce?: Uint8Array;
  /** Seconds before `now` the payment becomes valid, for clock skew. Default 30. */
  skew?: number;
}

/** Build and sign a `pq-escrow` payload for one request. */
export function createPayload(args: CreatePayloadArgs): PqEscrowPayload {
  const nonce = args.nonce ?? crypto.getRandomValues(new Uint8Array(32));
  if (nonce.length !== 32) throw new RangeError("nonce must be 32 bytes");
  const skew = args.skew ?? 30;
  const unsigned = {
    payer: args.payer,
    nonce: toHex(nonce),
    validAfter: String(Math.max(0, args.now - skew)),
    validBefore: String(args.now + args.requirements.maxTimeoutSeconds),
    requestHash: args.requestHash,
  };
  const message = paymentMessage(paymentOf(args.requirements, { ...unsigned, signature: "" }));
  return { ...unsigned, signature: toBase64(mldsaSign(args.secretKey, message)) };
}
