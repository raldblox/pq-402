import {
  mldsaVerify,
  paymentMessage,
  sameAddress,
  ML_DSA_87_ALGORITHM_ID,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  type Payment,
} from "@pq-402/core";
import { keccak256, toHex, type Hex } from "viem";
import { ChainUnavailableError, type ChainReader, type PqcKeyStatus, type Settler } from "./chain.js";

const key = (a: string) => a.toLowerCase();

/**
 * An in-memory stand-in for the chain: the `pqcKeyStatus` registry, the KEM
 * key registry and one `PQ402Escrow`, with real ML-DSA-87 verification.
 * `settle` repeats the checks of `PQ402Escrow.settle` in the same order.
 * For tests and the local example only; it proves nothing about the chain.
 */
export class MemoryChain implements ChainReader {
  private readonly keys = new Map<string, PqcKeyStatus>();
  private readonly kemKeys = new Map<string, Uint8Array>();
  private readonly balances = new Map<string, bigint>();
  private readonly used = new Set<string>();
  private readonly paid = new Map<string, bigint>();
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

  /** A settler that submits to this in-memory escrow. */
  settler(address: Hex): Settler {
    return {
      address,
      settle: async (p: Payment, signature: Uint8Array) => this.settle(p, signature),
    };
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
