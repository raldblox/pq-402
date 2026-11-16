import type { PaymentRequirements } from "@x402/core/types";
import { encodeAbiParameters, hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { fromBase64, isAddress, isHexOfLength, toBase64 } from "./bytes.js";
import { ML_DSA_87_SIGNATURE_LENGTH, PROTOCOL_VERSION } from "./constants.js";
import { mldsaSign } from "./mldsa.js";
import { evmChainIdOf } from "./payload.js";

/**
 * The `pq-perennial` scheme pays with a Perennial vault `spend` action:
 * `spend(positionId, to, amount, ref, deadline, signature)`, signed by the
 * position's beneficiary with ML-DSA-87 and relayed by the facilitator. The
 * signed bytes are the vault's `actionMessage` (docs/spec.md, section 5.3).
 */
export const PERENNIAL_ACTION_DOMAIN = keccak256(stringToBytes("Perennial.Action"));
/** `PerennialVault.Action.Spend`. */
export const PERENNIAL_SPEND_ACTION = 4;

/** One spend from a Perennial position's buffer. */
export interface PerennialSpend {
  chainId: bigint;
  vault: Hex;
  positionId: bigint;
  /** The position's action nonce at signing time; every signed action consumes one. */
  nonce: bigint;
  deadline: bigint;
  to: Hex;
  amount: bigint;
  /** Binds the HTTP request: the PQ-402 `requestHash`. */
  ref: Hex;
}

/** `keccak256(abi.encode(to, amount, ref))`, as the vault computes it. */
export function perennialSpendParamsHash(to: Hex, amount: bigint, ref: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [to.toLowerCase() as Hex, amount, ref],
    ),
  );
}

/** The vault's `actionMessage(positionId, Spend, nonce, deadline, paramsHash)`: 8 words, 256 bytes. */
export function perennialSpendMessage(s: PerennialSpend): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        PERENNIAL_ACTION_DOMAIN,
        s.chainId,
        s.vault.toLowerCase() as Hex,
        s.positionId,
        PERENNIAL_SPEND_ACTION,
        s.nonce,
        s.deadline,
        perennialSpendParamsHash(s.to, s.amount, s.ref),
      ],
    ),
  );
}

/** `PaymentPayload.payload` of the `pq-perennial` scheme (docs/spec.md section 4.2). */
export interface PqPerennialPayload {
  /** The position's beneficiary, whose ML-DSA-87 key signs. */
  payer: Hex;
  positionId: string;
  nonce: string;
  deadline: string;
  /** Equal to the request hash of the request it pays for. */
  ref: Hex;
  /** Base64 of the 4627-byte ML-DSA-87 signature over {@link perennialSpendMessage}. */
  signature: string;
}

export interface PqPerennialExtra {
  vault: Hex;
  version: typeof PROTOCOL_VERSION;
}

const UINT = /^(0|[1-9][0-9]{0,77})$/;

export function parsePerennialExtra(extra: unknown): PqPerennialExtra | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const e = extra as Record<string, unknown>;
  if (e.version !== PROTOCOL_VERSION || !isAddress(e.vault)) return undefined;
  return { vault: e.vault, version: PROTOCOL_VERSION };
}

export function parsePerennialPayload(payload: unknown): PqPerennialPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (!isAddress(p.payer) || !isHexOfLength(p.ref, 32) || typeof p.signature !== "string") return undefined;
  for (const k of ["positionId", "nonce", "deadline"] as const) {
    const v = p[k];
    if (typeof v !== "string" || !UINT.test(v) || BigInt(v) >= 1n << 256n) return undefined;
  }
  try {
    if (fromBase64(p.signature).length !== ML_DSA_87_SIGNATURE_LENGTH) return undefined;
  } catch {
    return undefined;
  }
  return {
    payer: p.payer,
    positionId: p.positionId as string,
    nonce: p.nonce as string,
    deadline: p.deadline as string,
    ref: p.ref,
    signature: p.signature,
  };
}

/** The spend a payload authorises against the requirements it accepted. */
export function perennialSpendOf(
  requirements: PaymentRequirements,
  payload: PqPerennialPayload,
): PerennialSpend {
  const extra = parsePerennialExtra(requirements.extra);
  if (!extra) throw new Error("requirements are not pq-perennial v1");
  if (!isAddress(requirements.payTo)) throw new Error("payTo must be an address");
  if (!UINT.test(requirements.amount)) throw new Error("amount must be a decimal integer");
  return {
    chainId: evmChainIdOf(requirements.network),
    vault: extra.vault,
    positionId: BigInt(payload.positionId),
    nonce: BigInt(payload.nonce),
    deadline: BigInt(payload.deadline),
    to: requirements.payTo,
    amount: BigInt(requirements.amount),
    ref: payload.ref,
  };
}

export interface CreatePerennialPayloadArgs {
  requirements: PaymentRequirements;
  /** The position's beneficiary. */
  payer: Hex;
  secretKey: Uint8Array;
  positionId: bigint;
  /** The position's current action nonce, read from the vault. */
  nonce: bigint;
  requestHash: Hex;
  now: number;
}

export function createPerennialPayload(a: CreatePerennialPayloadArgs): PqPerennialPayload {
  const unsigned = {
    payer: a.payer,
    positionId: a.positionId.toString(),
    nonce: a.nonce.toString(),
    deadline: String(a.now + a.requirements.maxTimeoutSeconds),
    ref: a.requestHash,
  };
  const message = perennialSpendMessage(perennialSpendOf(a.requirements, { ...unsigned, signature: "" }));
  return { ...unsigned, signature: toBase64(mldsaSign(a.secretKey, message)) };
}

/** Receipt payment id of a spend: `keccak256(abi.encode(positionId, nonce))`. */
export function perennialPaymentId(positionId: bigint, nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [positionId, nonce]));
}
