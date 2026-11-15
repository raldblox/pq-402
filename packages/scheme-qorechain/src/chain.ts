import type { Payment } from "@pq-402/core";
import type { Hex } from "viem";

/** What `pqcKeyStatus(account)` reports. */
export interface PqcKeyStatus {
  registered: boolean;
  algorithmId: number;
  publicKey: Uint8Array;
  possessionProven: boolean;
}

/**
 * Read access to the chain state PQ-402 depends on. Every method throws on a
 * failed or malformed read; callers turn that into a refusal, never a pass.
 */
export interface ChainReader {
  /** The account's ML-DSA-87 key record from the `pqcKeyStatus` precompile. */
  keyStatus(account: Hex): Promise<PqcKeyStatus>;
  /** The account's ML-KEM-1024 key from the KEM key registry. Throws when none is registered. */
  kemKey(account: Hex): Promise<Uint8Array>;
  nonceUsed(escrow: Hex, payer: Hex, nonce: Hex): Promise<boolean>;
  escrowBalance(escrow: Hex, payer: Hex): Promise<bigint>;
  /** Timestamp of the latest block, in unix seconds. */
  now(): Promise<number>;
}

export interface SettlementResult {
  transaction: Hex;
  /** Timestamp of the block that included it. */
  settledAt: number;
}

/** Submits settlements. Implementations pay the gas. */
export interface Settler {
  /** The account that sends settlement transactions. */
  readonly address: Hex;
  /** Send `settle(payment, signature)` to the escrow and wait until it is included. */
  settle(payment: Payment, signature: Uint8Array): Promise<SettlementResult>;
}

/** Thrown by chain adapters when the chain cannot answer or answers something malformed. */
export class ChainUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainUnavailableError";
  }
}
