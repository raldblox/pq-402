import {
  mldsaVerify,
  paymentMessage,
  sameAddress,
  ML_DSA_87_ALGORITHM_ID,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  perennialSpendMessage,
  type Payment,
  type PerennialSpend,
} from "@pq402/core";
import { keccak256, toHex, type Hex } from "viem";
import {
  ChainUnavailableError,
  type ChainReader,
  type PerennialPosition,
  type PqcKeyStatus,
  type Settler,
} from "./chain.js";

const key = (a: string) => a.toLowerCase();

/**
 * An in-memory stand-in for the chain: the `pqcKeyStatus` registry, the KEM
 * key registry, one `PQ402Escrow` and Perennial vault positions, with real
 * ML-DSA-87 verification. `settle` repeats the checks of `PQ402Escrow.settle`
 * and `spend` those of `PerennialVault.spend` (including budget mode), without
 * its yield accounting: the buffer is set directly and budget periods do not roll.
 * For tests and the local example only; it proves nothing about the chain.
 */
export class MemoryChain implements ChainReader {
  private readonly keys = new Map<string, PqcKeyStatus>();
  private readonly kemKeys = new Map<string, Uint8Array>();
  private readonly balances = new Map<string, bigint>();
  private readonly used = new Set<string>();
  private readonly paid = new Map<string, bigint>();
  private readonly positions = new Map<string, PerennialPosition & { vault: Hex }>();
  private clock: number;
  private txCount = 0;
  /** When true, every read throws, as an unreachable node would. */
  offline = false;

  constructor(
    readonly escrow: Hex,
    start = Math.floor(Date.now() / 1000),
  ) {
    this.clock = start;
  }

  registerKey(
    account: Hex,
    publicKey: Uint8Array,
    opts: { possessionProven?: boolean; algorithmId?: number } = {},
  ) {
    this.keys.set(key(account), {
      registered: true,
      algorithmId: opts.algorithmId ?? ML_DSA_87_ALGORITHM_ID,
      publicKey,
      possessionProven: opts.possessionProven ?? true,
    });
  }

  registerKemKey(account: Hex, publicKey: Uint8Array) {
    this.kemKeys.set(key(account), publicKey);
  }

  deposit(payer: Hex, amount: bigint) {
    this.balances.set(key(payer), (this.balances.get(key(payer)) ?? 0n) + amount);
  }

  /**
   * Open a Perennial position whose buffer already holds `buffer`. With
   * `budget`, it is in budget mode: `budget.perPeriod` may be spent per period,
   * from the buffer first and then `budget.principal`.
   */
  openPosition(
    vault: Hex,
    positionId: bigint,
    beneficiary: Hex,
    buffer: bigint,
    budget?: { perPeriod: bigint; principal: bigint },
  ) {
    this.positions.set(`${key(vault)}:${positionId}`, {
      vault,
      beneficiary,
      nonce: 0n,
      buffer,
      pendingYield: 0n,
      closed: false,
      succeeded: false,
      budgetMode: budget !== undefined,
      principal: budget?.principal ?? 0n,
      budgetRemaining: budget?.perPeriod ?? 0n,
    });
  }

  /** Total received by `payee` through settlements. */
  paidTo(payee: Hex): bigint {
    return this.paid.get(key(payee)) ?? 0n;
  }

  advance(seconds: number) {
    this.clock += seconds;
  }

  private online() {
    if (this.offline) throw new ChainUnavailableError("memory chain is offline");
  }

  async keyStatus(account: Hex): Promise<PqcKeyStatus> {
    this.online();
    return (
      this.keys.get(key(account)) ?? {
        registered: false,
        algorithmId: 0,
        publicKey: new Uint8Array(),
        possessionProven: false,
      }
    );
  }

  async kemKey(account: Hex): Promise<Uint8Array> {
    this.online();
    const k = this.kemKeys.get(key(account));
    if (!k) throw new Error(`no KEM key registered for ${account}`);
    return k;
  }

  async nonceUsed(escrow: Hex, payer: Hex, nonce: Hex): Promise<boolean> {
    this.online();
    return sameAddress(escrow, this.escrow) && this.used.has(`${key(payer)}:${key(nonce)}`);
  }

  async escrowBalance(escrow: Hex, payer: Hex): Promise<bigint> {
    this.online();
    return sameAddress(escrow, this.escrow) ? (this.balances.get(key(payer)) ?? 0n) : 0n;
  }

  async now(): Promise<number> {
    this.online();
    return this.clock;
  }

  async perennialPosition(vault: Hex, positionId: bigint): Promise<PerennialPosition> {
    this.online();
    const pos = this.positions.get(`${key(vault)}:${positionId}`);
    if (!pos) throw new Error(`UnknownPosition(${positionId})`);
    return {
      beneficiary: pos.beneficiary,
      nonce: pos.nonce,
      buffer: pos.buffer,
      pendingYield: pos.pendingYield,
      closed: pos.closed,
      succeeded: pos.succeeded,
      budgetMode: pos.budgetMode,
      principal: pos.principal,
      budgetRemaining: pos.budgetRemaining,
    };
  }

  /** A settler that submits to this in-memory escrow and vault. */
  settler(address: Hex): Settler {
    return {
      address,
      settle: async (p: Payment, signature: Uint8Array) => this.settle(p, signature),
      spend: async (s: PerennialSpend, signature: Uint8Array) => this.spend(s, signature),
    };
  }

  private spend(s: PerennialSpend, signature: Uint8Array) {
    this.online();
    const pos = this.positions.get(`${key(s.vault)}:${s.positionId}`);
    if (!pos) throw new Error("UnknownPosition");
    if (pos.closed) throw new Error("PositionClosed");
    if (pos.succeeded) throw new Error("PositionSucceeded");
    if (s.amount === 0n) throw new Error("ZeroAmount");
    if (BigInt(this.clock) > s.deadline) throw new Error("SignatureExpired");
    const k = this.keys.get(key(pos.beneficiary));
    if (!k?.registered || !k.possessionProven) throw new Error("PQCKeyNotProven");
    const message = perennialSpendMessage({ ...s, nonce: pos.nonce });
    if (!mldsaVerify(k.publicKey, message, signature)) throw new Error("PQCSignatureInvalid");
    // A reverted transaction changes nothing, so check before touching state.
    if (pos.budgetMode) {
      if (s.amount > pos.budgetRemaining)
        throw new Error(`BudgetExceeded(${s.positionId}, ${pos.budgetRemaining})`);
      if (s.amount > pos.buffer + pos.principal) throw new Error("InsufficientBuffer");
    } else if (s.amount > pos.buffer) {
      throw new Error("InsufficientBuffer");
    }
    pos.nonce += 1n;
    if (pos.budgetMode) {
      pos.budgetRemaining -= s.amount;
      const fromBuffer = s.amount < pos.buffer ? s.amount : pos.buffer;
      pos.buffer -= fromBuffer;
      pos.principal -= s.amount - fromBuffer;
    } else {
      pos.buffer -= s.amount;
    }
    this.paid.set(key(s.to), (this.paid.get(key(s.to)) ?? 0n) + s.amount);
    this.txCount += 1;
    return { transaction: keccak256(toHex(`memory-spend-${this.txCount}`)), settledAt: this.clock };
  }

  private settle(p: Payment, signature: Uint8Array) {
    this.online();
    if (!sameAddress(p.escrow, this.escrow)) throw new Error("unknown escrow");
    if (p.amount === 0n) throw new Error("ZeroAmount");
    const nonceKey = `${key(p.payer)}:${key(p.nonce)}`;
    if (this.used.has(nonceKey)) throw new Error("NonceAlreadyUsed");
    if (BigInt(this.clock) < p.validAfter) throw new Error("NotYetValid");
    if (BigInt(this.clock) >= p.validBefore) throw new Error("Expired");
    const balance = this.balances.get(key(p.payer)) ?? 0n;
    if (balance < p.amount) throw new Error("InsufficientBalance");
    const k = this.keys.get(key(p.payer));
    if (!k?.registered) throw new Error("PQCKeyNotRegistered");
    if (k.algorithmId !== ML_DSA_87_ALGORITHM_ID || k.publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH) {
      throw new Error("PQCKeyUnsupported");
    }
    if (!k.possessionProven) throw new Error("PQCKeyNotProven");
    if (!mldsaVerify(k.publicKey, paymentMessage(p), signature)) throw new Error("PQCSignatureInvalid");

    this.used.add(nonceKey);
    this.balances.set(key(p.payer), balance - p.amount);
    this.paid.set(key(p.payTo), (this.paid.get(key(p.payTo)) ?? 0n) + p.amount);
    this.txCount += 1;
    return { transaction: keccak256(toHex(`memory-settlement-${this.txCount}`)), settledAt: this.clock };
  }
}
