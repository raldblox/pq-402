import { fetchMlkemPublicKey } from "@qorechain/qoreseal/network";
import { PQC_KEY_STATUS_ADDRESS, type Payment, type PerennialSpend } from "@pq402/core";
import {
  createPublicClient,
  parseEventLogs,
  hexToBytes,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { perennialVaultAbi, pq402EscrowAbi, pqcPrecompileAbi } from "./abi.js";
import {
  ChainUnavailableError,
  type ChainReader,
  type PerennialPosition,
  type PqcKeyStatus,
  type Settler,
} from "./chain.js";
import type { QoreNetwork } from "./network.js";

/** A viem chain definition for a QoreChain network's EVM lane. */
export function viemChainOf(network: QoreNetwork): Chain {
  return {
    id: network.evmChainId,
    name: `QoreChain ${network.chainId}`,
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [network.evmRpc] } },
  };
}

async function guarded<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new ChainUnavailableError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

export interface EvmChainReaderOptions {
  network: QoreNetwork;
  publicClient?: PublicClient;
  /** `fetch` used for the REST API (KEM registry). */
  fetch?: typeof fetch;
}

/**
 * Reads PQ-402's chain state from a QoreChain node: the PQC precompiles and the
 * escrow over EVM JSON-RPC, the KEM key registry over REST. An inactive
 * precompile answers with empty data, which viem refuses to decode, so it
 * surfaces as a `ChainUnavailableError`, never as a key.
 */
export class EvmChainReader implements ChainReader {
  readonly client: PublicClient;

  constructor(private readonly options: EvmChainReaderOptions) {
    this.client =
      options.publicClient ??
      (createPublicClient({ chain: viemChainOf(options.network), transport: http() }) as PublicClient);
  }

  async keyStatus(account: Hex): Promise<PqcKeyStatus> {
    const [registered, algorithmId, pubkey, possessionProven] = await guarded("pqcKeyStatus", () =>
      this.client.readContract({
        address: PQC_KEY_STATUS_ADDRESS,
        abi: pqcPrecompileAbi,
        functionName: "pqcKeyStatus",
        args: [account],
      }),
    );
    return { registered, algorithmId, publicKey: hexToBytes(pubkey), possessionProven };
  }

  async kemKey(account: Hex): Promise<Uint8Array> {
    return guarded("KEM key registry", () =>
      fetchMlkemPublicKey({
        rest: this.options.network.rest,
        address: account,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      }),
    );
  }

  async nonceUsed(escrow: Hex, payer: Hex, nonce: Hex): Promise<boolean> {
    return guarded("nonceUsed", () =>
      this.client.readContract({
        address: escrow,
        abi: pq402EscrowAbi,
        functionName: "nonceUsed",
        args: [payer, nonce],
      }),
    );
  }

  async escrowBalance(escrow: Hex, payer: Hex): Promise<bigint> {
    return guarded("balanceOf", () =>
      this.client.readContract({
        address: escrow,
        abi: pq402EscrowAbi,
        functionName: "balanceOf",
        args: [payer],
      }),
    );
  }

  async perennialPosition(vault: Hex, positionId: bigint): Promise<PerennialPosition> {
    const [pos, pendingYield] = await guarded("Perennial position", () =>
      Promise.all([
        this.client.readContract({
          address: vault,
          abi: perennialVaultAbi,
          functionName: "position",
          args: [positionId],
        }),
        this.client.readContract({
          address: vault,
          abi: perennialVaultAbi,
          functionName: "pendingYield",
          args: [positionId],
        }),
      ]),
    );
    return {
      beneficiary: pos.beneficiary,
      nonce: pos.nonce,
      buffer: pos.buffer,
      pendingYield,
      closed: pos.closed,
      succeeded: pos.succeeded,
    };
  }

  async now(): Promise<number> {
    const block = await guarded("latest block", () => this.client.getBlock({ blockTag: "latest" }));
    return Number(block.timestamp);
  }
}

export interface EvmSettlerOptions {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  /**
   * Gas limit for `settle` and `spend`. The EVM lane bills at least half the
   * limit, so keep it near the measured cost: `settle` used 253,160 and
   * 253,388 gas on the testnet (16 November 2026). Default 350,000.
   */
  gas?: bigint;
  /**
   * Fee caps. Each transaction reserves `gas × maxFeePerGas` of the relayer's
   * EVM window, so leaving them to the wallet's defaults (2 × base fee) can
   * exhaust a window sized for a lower cap. Default: the wallet's choice.
   */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/** Sends `settle` from a wallet that holds an open EVM window scoped to the escrow. */
export class EvmSettler implements Settler {
  readonly address: Hex;

  constructor(private readonly options: EvmSettlerOptions) {
    this.address = options.walletClient.account.address;
  }

  private fees() {
    const { gas, maxFeePerGas, maxPriorityFeePerGas } = this.options;
    return {
      gas: gas ?? 350_000n,
      ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
      ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
    };
  }

  async settle(payment: Payment, signature: Uint8Array) {
    const { publicClient, walletClient } = this.options;
    const args = [
      {
        payer: payment.payer,
        payTo: payment.payTo,
        amount: payment.amount,
        nonce: payment.nonce,
        validAfter: payment.validAfter,
        validBefore: payment.validBefore,
        requestHash: payment.requestHash,
      },
      `0x${Buffer.from(signature).toString("hex")}`,
    ] as const;
    const hash = await walletClient.writeContract({
      address: payment.escrow,
      abi: pq402EscrowAbi,
      functionName: "settle",
      args,
      ...this.fees(),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`settlement reverted in ${hash}`);
    const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
    return { transaction: hash, settledAt: Number(block.timestamp) };
  }

  /** Relays `vault.spend(...)` and requires the matching `Spent` event in the receipt. */
  async spend(s: PerennialSpend, signature: Uint8Array) {
    const { publicClient, walletClient } = this.options;
    const hash = await walletClient.writeContract({
      address: s.vault,
      abi: perennialVaultAbi,
      functionName: "spend",
      args: [s.positionId, s.to, s.amount, s.ref, s.deadline, `0x${Buffer.from(signature).toString("hex")}`],
      ...this.fees(),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`spend reverted in ${hash}`);
    const spent = parseEventLogs({ abi: perennialVaultAbi, eventName: "Spent", logs: receipt.logs }).find(
      (log) =>
        log.address.toLowerCase() === s.vault.toLowerCase() &&
        log.args.positionId === s.positionId &&
        log.args.to.toLowerCase() === s.to.toLowerCase() &&
        log.args.amount === s.amount &&
        log.args.ref.toLowerCase() === s.ref.toLowerCase(),
    );
    if (!spent) throw new Error(`no matching Spent event in ${hash}`);
    const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
    return { transaction: hash, settledAt: Number(block.timestamp) };
  }
}
