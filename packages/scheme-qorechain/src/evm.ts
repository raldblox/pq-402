import { fetchMlkemPublicKey } from "@qorechain/qoreseal/network";
import {
  PERENNIAL_SPEND_ACTION,
  PQC_KEY_STATUS_ADDRESS,
  perennialSpendParamsHash,
  type Payment,
  type PerennialSpend,
} from "@pq402/core";
import {
  BaseError,
  ContractFunctionRevertedError,
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
    const at = { address: vault, abi: perennialVaultAbi, args: [positionId] } as const;
    const [pos, pendingYield, budgetRemaining] = await guarded("Perennial position", () =>
      Promise.all([
        this.client.readContract({ ...at, functionName: "position" }),
        this.client.readContract({ ...at, functionName: "pendingYield" }),
        this.client.readContract({ ...at, functionName: "budgetRemaining" }),
      ]),
    );
    return {
      beneficiary: pos.beneficiary,
      nonce: pos.nonce,
      buffer: pos.buffer,
      pendingYield,
      closed: pos.closed,
      succeeded: pos.succeeded,
      budgetMode: pos.budgetMode,
      principal: pos.principal,
      budgetRemaining,
    };
  }

  async perennialSpendMessage(s: PerennialSpend): Promise<Uint8Array> {
    const message = await guarded("Perennial actionMessage", () =>
      this.client.readContract({
        address: s.vault,
        abi: perennialVaultAbi,
        functionName: "actionMessage",
        args: [
          s.positionId,
          PERENNIAL_SPEND_ACTION,
          s.nonce,
          s.deadline,
          perennialSpendParamsHash(s.to, s.amount, s.ref),
        ],
      }),
    );
    return hexToBytes(message);
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
   * A fixed gas limit for every `settle` and `spend`. When unset (the
   * default), each call is estimated with `eth_estimateGas` and sent with
   * {@link gasHeadroomPercent} on top: a Perennial spend that has to redeem
   * principal costs far more than one paid from the buffer. The EVM lane
   * bills at least half the limit, so a generous constant would overcharge.
   */
  gas?: bigint;
  /** Added to the estimate, in percent. Default 20. */
  gasHeadroomPercent?: number;
  /**
   * Largest limit the settler will send. A call estimated above it is refused
   * before anything is sent. Size the relayer's EVM window for it.
   * Default 1,000,000.
   */
  maxGas?: bigint;
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
    const { maxFeePerGas, maxPriorityFeePerGas } = this.options;
    return {
      ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
      ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
    };
  }

  /**
   * The gas limit for `call`: the fixed `gas` option if set, otherwise the
   * node's estimate plus headroom. An estimate that reverts (the contract
   * would refuse the call) or exceeds `maxGas` is an error, and nothing is sent.
   */
  private async gasFor(
    call: Parameters<PublicClient["estimateContractGas"]>[0],
    what: string,
  ): Promise<bigint> {
    if (this.options.gas !== undefined) return this.options.gas;
    const maxGas = this.options.maxGas ?? 1_000_000n;
    let estimate: bigint;
    try {
      estimate = await this.options.publicClient.estimateContractGas(call);
    } catch (err) {
      // viem decodes a custom error (BudgetExceeded, InsufficientBuffer, ...); keep its name.
      const revert =
        err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
      const decoded =
        revert instanceof ContractFunctionRevertedError
          ? (revert.data?.errorName ?? revert.reason)
          : undefined;
      const firstLine = err instanceof Error ? (err.message.split(/\r?\n/)[0] ?? err.message) : String(err);
      const reason = decoded ? `${decoded} (${firstLine})` : firstLine;
      throw new Error(`${what} would revert, not sent: ${reason}`, { cause: err });
    }
    const headroom = BigInt(Math.round((this.options.gasHeadroomPercent ?? 20) * 100));
    const limit = (estimate * (10_000n + headroom) + 9_999n) / 10_000n;
    if (limit > maxGas) {
      throw new Error(
        `${what} needs about ${estimate} gas (${limit} with headroom), above the cap of ${maxGas}; not sent`,
      );
    }
    return limit;
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
    const call = { address: payment.escrow, abi: pq402EscrowAbi, functionName: "settle", args } as const;
    // Estimate first: a payment the contract would refuse costs nothing and reports why.
    const gas = await this.gasFor({ ...call, account: walletClient.account }, "settle");
    const hash = await walletClient.writeContract({ ...call, gas, ...this.fees() });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`settlement reverted in ${hash}`);
    const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
    return { transaction: hash, settledAt: Number(block.timestamp) };
  }

  /** Relays `vault.spend(...)` and requires the matching `Spent` event in the receipt. */
  async spend(s: PerennialSpend, signature: Uint8Array) {
    const { publicClient, walletClient } = this.options;
    const call = {
      address: s.vault,
      abi: perennialVaultAbi,
      functionName: "spend",
      args: [s.positionId, s.to, s.amount, s.ref, s.deadline, `0x${Buffer.from(signature).toString("hex")}`],
    } as const;
    // Estimate first: a spend the vault would refuse (BudgetExceeded, InsufficientBuffer)
    // costs nothing and its revert reason reaches the facilitator. A spend that redeems
    // principal costs more than one paid from the buffer; the estimate covers both.
    const gas = await this.gasFor({ ...call, account: walletClient.account }, "spend");
    const hash = await walletClient.writeContract({ ...call, gas, ...this.fees() });
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
