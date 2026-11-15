import { keccak256, type Hex } from "viem";
import { fromBase64, isAddress, isHexOfLength, sameAddress, toBase64 } from "./bytes.js";
import { receiptMessage, type Payment } from "./encoding.js";
import { mldsaSign, mldsaVerify } from "./mldsa.js";

/** `SettleResponse.extensions["pq402-sealing"].receipt` (docs/spec.md section 8.3). */
export interface Receipt {
  gateway: Hex;
  requestHash: Hex;
  responseHash: Hex;
  transaction: Hex;
  settledAt: string;
  /** Base64 of the gateway's ML-DSA-87 signature over the receipt message. */
  signature: string;
}

export interface SignReceiptArgs {
  payment: Payment;
  gateway: Hex;
  /** The gateway's ML-DSA-87 secret key, matching the key registered on chain. */
  secretKey: Uint8Array;
  /** The sealed response body exactly as sent. */
  responseBody: Uint8Array;
  transaction: Hex;
  settledAt: number;
}

function messageOf(payment: Payment, r: Omit<Receipt, "signature">): Uint8Array {
  return receiptMessage({
    chainId: payment.chainId,
    escrow: payment.escrow,
    gateway: r.gateway,
    payer: payment.payer,
    payTo: payment.payTo,
    amount: payment.amount,
    nonce: payment.nonce,
    requestHash: r.requestHash,
    responseHash: r.responseHash,
    transaction: r.transaction,
    settledAt: BigInt(r.settledAt),
  });
}

export function signReceipt(a: SignReceiptArgs): Receipt {
  const fields = {
    gateway: a.gateway,
    requestHash: a.payment.requestHash,
    responseHash: keccak256(a.responseBody),
    transaction: a.transaction,
    settledAt: String(a.settledAt),
  };
  return { ...fields, signature: toBase64(mldsaSign(a.secretKey, messageOf(a.payment, fields))) };
}

export function parseReceipt(value: unknown): Receipt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (!isAddress(r.gateway) || !isHexOfLength(r.requestHash, 32) || !isHexOfLength(r.responseHash, 32)) {
    return undefined;
  }
  if (
    !isHexOfLength(r.transaction, 32) ||
    typeof r.settledAt !== "string" ||
    !/^[0-9]{1,19}$/.test(r.settledAt)
  ) {
    return undefined;
  }
  if (typeof r.signature !== "string") return undefined;
  return {
    gateway: r.gateway,
    requestHash: r.requestHash,
    responseHash: r.responseHash,
    transaction: r.transaction,
    settledAt: r.settledAt,
    signature: r.signature,
  };
}

export interface VerifyReceiptArgs {
  receipt: Receipt;
  /** The payment the client signed. */
  payment: Payment;
  /** The gateway the client expected (from the `402`). */
  gateway: Hex;
  /** The gateway's ML-DSA-87 key, read from `pqcKeyStatus`. */
  gatewayKey: Uint8Array;
  /** The response body exactly as received. */
  responseBody: Uint8Array;
}

/** Returns why the receipt is unacceptable, or `undefined` when it checks out. */
export function receiptProblem(a: VerifyReceiptArgs): string | undefined {
  if (!sameAddress(a.receipt.gateway, a.gateway)) return "receipt is from another gateway";
  if (a.receipt.requestHash.toLowerCase() !== a.payment.requestHash.toLowerCase()) {
    return "receipt is for another request";
  }
  if (a.receipt.responseHash.toLowerCase() !== keccak256(a.responseBody).toLowerCase()) {
    return "receipt does not match the response body";
  }
  let signature: Uint8Array;
  try {
    signature = fromBase64(a.receipt.signature);
  } catch {
    return "receipt signature is not base64";
  }
  if (!mldsaVerify(a.gatewayKey, messageOf(a.payment, a.receipt), signature)) {
    return "receipt signature is invalid";
  }
  return undefined;
}
