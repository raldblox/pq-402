import { encodeAbiParameters, hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { PAYMENT_DOMAIN, RECEIPT_DOMAIN, REQUEST_DOMAIN, WITHDRAWAL_DOMAIN } from "./constants.js";

/** The fields of one payment, as the escrow contract sees them. */
export interface Payment {
  chainId: bigint;
  escrow: Hex;
  payer: Hex;
  payTo: Hex;
  asset: Hex;
  amount: bigint;
  nonce: Hex;
  validAfter: bigint;
  validBefore: bigint;
  requestHash: Hex;
}

export interface Withdrawal {
  chainId: bigint;
  escrow: Hex;
  payer: Hex;
  amount: bigint;
  nonce: Hex;
  deadline: bigint;
}

export interface ReceiptFields {
  chainId: bigint;
  /** The contract that settled the payment: the escrow (`pq-erc20`) or the vault (`pq-perennial`). */
  settlement: Hex;
  gateway: Hex;
  payer: Hex;
  payTo: Hex;
  amount: bigint;
  /** Identifies the payment within `settlement`; see {@link paymentIdOf}. */
  paymentId: Hex;
  requestHash: Hex;
  responseHash: Hex;
  transaction: Hex;
  settledAt: bigint;
}

export interface RequestDescription {
  /** HTTP method; compared upper-case. */
  method: string;
  /** Request target in origin form: path, then `?` and the query if any. */
  target: string;
  /** Body bytes exactly as sent; empty when there is none. */
  body: Uint8Array;
}

const UINT64_MAX = (1n << 64n) - 1n;

/** ABI encoding of an address does not depend on case; viem checks EIP-55 checksums, so lower-case first. */
function addr(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

function uint64(value: bigint, name: string): bigint {
  if (value < 0n || value > UINT64_MAX) throw new RangeError(`${name} does not fit in uint64`);
  return value;
}

/** Path and query of a URL, as an HTTP client puts them in the request line. */
export function requestTarget(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  return `${u.pathname}${u.search}`;
}

/** `requestHash` of docs/spec.md section 5.1. */
export function requestHash(req: RequestDescription): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        REQUEST_DOMAIN,
        keccak256(stringToBytes(req.method.toUpperCase())),
        keccak256(stringToBytes(req.target)),
        keccak256(req.body),
      ],
    ),
  );
}

/** The 352 bytes a payer signs (docs/spec.md section 5.2). */
export function paymentMessage(p: Payment): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [
        PAYMENT_DOMAIN,
        p.chainId,
        addr(p.escrow),
        addr(p.payer),
        addr(p.payTo),
        addr(p.asset),
        p.amount,
        p.nonce,
        uint64(p.validAfter, "validAfter"),
        uint64(p.validBefore, "validBefore"),
        p.requestHash,
      ],
    ),
  );
}

/** The bytes a payer signs to start a withdrawal from the escrow. */
export function withdrawalMessage(w: Withdrawal): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        WITHDRAWAL_DOMAIN,
        w.chainId,
        addr(w.escrow),
        addr(w.payer),
        w.amount,
        w.nonce,
        uint64(w.deadline, "deadline"),
      ],
    ),
  );
}

/** The bytes a gateway signs to acknowledge a paid, served request (docs/spec.md section 8.3). */
export function receiptMessage(r: ReceiptFields): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        RECEIPT_DOMAIN,
        r.chainId,
        addr(r.settlement),
        addr(r.gateway),
        addr(r.payer),
        addr(r.payTo),
        r.amount,
        r.paymentId,
        r.requestHash,
        r.responseHash,
        r.transaction,
        uint64(r.settledAt, "settledAt"),
      ],
    ),
  );
}
