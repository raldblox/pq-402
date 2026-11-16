import type { Payment, PerennialSpend } from "@pq402/core";
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
  /** A Perennial position, for the `pq-perennial` scheme. */
  perennialPosition?(vault: Hex, positionId: bigint): Promise<PerennialPosition>;
  /**
   * The vault's own `actionMessage(positionId, Spend, nonce, deadline, paramsHash)`.
   * When available the facilitator requires it to equal the locally encoded bytes.
   */
  perennialSpendMessage?(spend: PerennialSpend): Promise<Uint8Array>;
}

/** The parts of a Perennial position the `pq-perennial` scheme checks. */
export interface PerennialPosition {
  beneficiary: Hex;
  /** Action nonce; each signed action consumes one. */
  nonce: bigint;
  buffer: bigint;
  /** Yield `spend` harvests into the buffer before paying. */
  pendingYield: bigint;
  closed: boolean;
  succeeded: boolean;
  /**
   * Budget mode (fixed when the position is opened): every spend counts against a
   * per-period budget (`budgetRemaining`), and is paid from the buffer, then the principal.
   */
  budgetMode: boolean;
  principal: bigint;
  /** What a budget-mode position may still spend this period; zero otherwise. */
  budgetRemaining: bigint;
}

/** Why a position cannot pay `amount` now, as an error code; `undefined` when it can. */
export function perennialShortfall(pos: PerennialPosition, amount: bigint): "budget" | "funds" | undefined {
  const spendable = pos.buffer + pos.pendingYield + (pos.budgetMode ? pos.principal : 0n);
  if (pos.budgetMode && amount > pos.budgetRemaining) return "budget";
  if (amount > spendable) return "funds";
  return undefined;
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
  /**
   * Send `spend(...)` to a Perennial vault, wait until it is included, and
   * confirm the `Spent(positionId, to, amount, ref)` event. Needed for `pq-perennial`.
   */
  spend?(spend: PerennialSpend, signature: Uint8Array): Promise<SettlementResult>;
}

/** Thrown by chain adapters when the chain cannot answer or answers something malformed. */
export class ChainUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainUnavailableError";
  }
}
