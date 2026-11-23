import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  numberToHex,
  parseTransaction,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { EvmSettler, perennialVaultAbi, qorechainTestnet, viemChainOf } from "../src/index.js";

const VAULT: Hex = "0x76dac5461ff361f911e5f39810c9455a6180c180";
const PAYEE: Hex = "0x3333333333333333333333333333333333333333";
const REF: Hex = `0x${"aa".repeat(32)}`;

const spend = {
  chainId: 9800n,
  vault: VAULT,
  positionId: 2n,
  nonce: 0n,
  deadline: 1_800_000_000n,
  to: PAYEE,
  amount: 2_000n,
  ref: REF,
};

const payment = {
  chainId: 9800n,
  escrow: "0x1111111111111111111111111111111111111111" as Hex,
  payer: "0x2222222222222222222222222222222222222222" as Hex,
  payTo: PAYEE,
  asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as Hex,
  amount: 1n,
  nonce: `0x${"44".repeat(32)}` as Hex,
  validAfter: 0n,
  validBefore: 1n,
  requestHash: `0x${"55".repeat(32)}` as Hex,
};

/** The `Spent` log the vault emits for `spend`. */
const spentLog = {
  address: VAULT,
  topics: encodeEventTopics({
    abi: perennialVaultAbi,
    eventName: "Spent",
    args: { positionId: spend.positionId, to: PAYEE, ref: REF },
  }),
  data: encodeAbiParameters([{ type: "uint256" }], [spend.amount]),
  blockNumber: "0x1",
  transactionHash: `0x${"11".repeat(32)}`,
  transactionIndex: "0x0",
  blockHash: `0x${"22".repeat(32)}`,
  logIndex: "0x0",
  removed: false,
};

/**
 * A node that answers `eth_estimateGas` with `estimate` (or fails it), accepts
 * one raw transaction and reports it mined with `logs`.
 */
function fakeNode(opts: { estimate: bigint | Error; logs?: unknown[] }) {
  const sent: Hex[] = [];
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      switch (method) {
        case "eth_chainId":
          return "0x2648";
        case "eth_getTransactionCount":
          return "0x5";
        case "eth_estimateGas":
          if (opts.estimate instanceof Error) throw opts.estimate;
          return numberToHex(opts.estimate);
        case "eth_sendRawTransaction":
          sent.push((params as [Hex])[0]);
          return `0x${"11".repeat(32)}`;
        case "eth_getTransactionReceipt":
          return {
            status: "0x1",
            blockHash: `0x${"22".repeat(32)}`,
            blockNumber: "0x1",
            logs: opts.logs ?? [],
            gasUsed: "0x1",
            transactionHash: `0x${"11".repeat(32)}`,
            transactionIndex: "0x0",
            cumulativeGasUsed: "0x1",
            effectiveGasPrice: "0x1",
            from: "0x0000000000000000000000000000000000000001",
            to: VAULT,
            type: "0x2",
            logsBloom: `0x${"00".repeat(256)}`,
            contractAddress: null,
          };
        case "eth_getBlockByHash":
        case "eth_getBlockByNumber":
          return {
            number: "0x1",
            timestamp: "0x6900",
            hash: `0x${"22".repeat(32)}`,
            baseFeePerGas: "0x174876e800",
            transactions: [],
          };
        case "eth_blockNumber":
          return "0x1";
        case "eth_maxPriorityFeePerGas":
          return "0x3b9aca00";
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  return { transport, sent };
}

function settler(
  node: ReturnType<typeof fakeNode>,
  extra: Partial<ConstructorParameters<typeof EvmSettler>[0]> = {},
) {
  const chain = viemChainOf(qorechainTestnet);
  return new EvmSettler({
    publicClient: createPublicClient({
      chain,
      transport: node.transport,
      pollingInterval: 10,
    }) as PublicClient,
    walletClient: createWalletClient({
      account: privateKeyToAccount(`0x${"07".repeat(32)}`),
      chain,
      transport: node.transport,
    }),
    maxFeePerGas: 150_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...extra,
  });
}

describe("EvmSettler gas limits", () => {
  it("sends settle with the node's estimate plus 20% and the configured fee caps", async () => {
    const node = fakeNode({ estimate: 253_160n });
    await settler(node).settle(payment, new Uint8Array(4627));
    const tx = parseTransaction(node.sent[0]!);
    expect(tx.gas).toBe(303_792n);
    expect(tx.maxFeePerGas).toBe(150_000_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it("gives a principal-draw spend the gas it needs, above the old fixed 350,000", async () => {
    // A budget-mode spend from an empty buffer redeems shares from the yield source; on the
    // testnet the fixed 350,000 limit ran out in 0xbacd8524…5d26. Estimated here at 480,000.
    const node = fakeNode({ estimate: 480_000n, logs: [spentLog] });
    const out = await settler(node).spend(spend, new Uint8Array(4627));
    expect(parseTransaction(node.sent[0]!).gas).toBe(576_000n);
    expect(out.transaction).toBe(`0x${"11".repeat(32)}`);
  });

  it("refuses before sending when the estimate is above the cap", async () => {
    const node = fakeNode({ estimate: 900_000n, logs: [spentLog] });
    await expect(settler(node).spend(spend, new Uint8Array(4627))).rejects.toThrow(
      /above the cap of 1000000; not sent/,
    );
    expect(node.sent).toHaveLength(0);
  });

  it("refuses before sending when the call would revert, keeping the reason", async () => {
    const node = fakeNode({
      // What a node returns when the vault reverts with BudgetExceeded(2, 0).
      estimate: Object.assign(new Error("execution reverted"), {
        code: 3,
        data: encodeErrorResult({ abi: perennialVaultAbi, errorName: "BudgetExceeded", args: [2n, 0n] }),
      }),
      logs: [spentLog],
    });
    const err = (await settler(node)
      .spend(spend, new Uint8Array(4627))
      .then(() => new Error("was sent"))
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/spend would revert, not sent/);
    expect(err.message).toMatch(/BudgetExceeded/);
    expect(node.sent).toHaveLength(0);
  });

  it("uses a fixed limit when one is configured, without estimating", async () => {
    const node = fakeNode({ estimate: new Error("estimate must not be called"), logs: [spentLog] });
    await settler(node, { gas: 420_000n }).spend(spend, new Uint8Array(4627));
    expect(parseTransaction(node.sent[0]!).gas).toBe(420_000n);
  });
});
