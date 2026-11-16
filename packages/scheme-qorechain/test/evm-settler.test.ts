import {
  createPublicClient,
  createWalletClient,
  custom,
  parseTransaction,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { EvmSettler, qorechainTestnet, viemChainOf } from "../src/index.js";

/** A node that accepts one raw transaction and reports it mined, recording what was sent. */
function fakeNode(sent: Hex[]) {
  return custom({
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      switch (method) {
        case "eth_chainId":
          return "0x2648";
        case "eth_getTransactionCount":
          return "0x5";
        case "eth_sendRawTransaction":
          sent.push((params as [Hex])[0]);
          return `0x${"11".repeat(32)}`;
        case "eth_getTransactionReceipt":
          return {
            status: "0x1",
            blockHash: `0x${"22".repeat(32)}`,
            blockNumber: "0x1",
            logs: [],
            gasUsed: "0x1",
            transactionHash: `0x${"11".repeat(32)}`,
            transactionIndex: "0x0",
            cumulativeGasUsed: "0x1",
            effectiveGasPrice: "0x1",
            from: "0x0000000000000000000000000000000000000001",
            to: null,
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
        case "eth_call":
          // The simulation before sending: settle returns nothing.
          return "0x";
        case "eth_maxPriorityFeePerGas":
          return "0x3b9aca00";
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
}

describe("EvmSettler", () => {
  it("sends settle with the configured gas limit and fee caps", async () => {
    const sent: Hex[] = [];
    const chain = viemChainOf(qorechainTestnet);
    const transport = fakeNode(sent);
    const account = privateKeyToAccount(`0x${"07".repeat(32)}`);
    const settler = new EvmSettler({
      publicClient: createPublicClient({ chain, transport, pollingInterval: 10 }) as PublicClient,
      walletClient: createWalletClient({ account, chain, transport }),
      maxFeePerGas: 150_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    await settler.settle(
      {
        chainId: 9800n,
        escrow: "0x1111111111111111111111111111111111111111",
        payer: "0x2222222222222222222222222222222222222222",
        payTo: "0x3333333333333333333333333333333333333333",
        asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
        amount: 1n,
        nonce: `0x${"44".repeat(32)}`,
        validAfter: 0n,
        validBefore: 1n,
        requestHash: `0x${"55".repeat(32)}`,
      },
      new Uint8Array(4627),
    );
    const tx = parseTransaction(sent[0]!);
    expect(tx.gas).toBe(350_000n);
    expect(tx.maxFeePerGas).toBe(150_000_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });
});
