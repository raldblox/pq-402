import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { createPublicClient, custom, encodeFunctionResult, toHex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  ChainUnavailableError,
  EvmChainReader,
  pqcPrecompileAbi,
  PqEscrowClientScheme,
  PqEscrowServerScheme,
  qorechainTestnet,
  viemChainOf,
} from "../src/index.js";
import { ESCROW, PAYER, REQUEST_HASH, T0, payerKeys, requirements } from "./fixtures.js";

describe("PqEscrowServerScheme", () => {
  const server = new PqEscrowServerScheme({ network: qorechainTestnet, escrow: ESCROW });

  it("prices dollars in fUSD atomic units", async () => {
    expect(await server.parsePrice("$0.01", "eip155:9800")).toEqual({
      asset: qorechainTestnet.defaultAsset.address,
      amount: "10000",
    });
    expect(await server.parsePrice("0.5 fUSD", "eip155:9800")).toEqual({
      asset: qorechainTestnet.defaultAsset.address,
      amount: "500000",
    });
    await expect(server.parsePrice("1 USDC", "eip155:9800")).rejects.toThrow(/fUSD/);
    await expect(server.parsePrice("$1", "eip155:8453")).rejects.toThrow();
  });

  it("adds the escrow and version to extra", async () => {
    const base = { ...requirements, extra: {} };
    const out = await server.enhancePaymentRequirements(
      base,
      { x402Version: 2, scheme: "pq-escrow", network: "eip155:9800" },
      [],
    );
    expect(out.extra).toEqual({ escrow: ESCROW, version: "1" });
  });

  it("declares the authorization flow only", () => {
    expect(server.paymentFlows.default.supported).toEqual(["authorization"]);
    expect(server.getAssetDecimals(qorechainTestnet.defaultAsset.address, "eip155:9800")).toBe(6);
  });
});

describe("PqEscrowClientScheme with x402Client", () => {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://localhost/paid/hello" },
    accepts: [{ ...requirements, scheme: "exact" }, requirements],
  };

  it("refuses to sign before it is bound to a request", async () => {
    const scheme = new PqEscrowClientScheme({ payer: PAYER, secretKey: payerKeys.secretKey });
    await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(/forRequest/);
  });

  it("is selected by x402Client from a 402 that also offers exact", async () => {
    const scheme = new PqEscrowClientScheme({ payer: PAYER, secretKey: payerKeys.secretKey, now: () => T0 });
    const client = new x402Client().register("eip155:9800", scheme.forRequest(REQUEST_HASH));
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(paymentRequired);
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted.scheme).toBe("pq-escrow");
    expect(payload.payload.requestHash).toBe(REQUEST_HASH);
    expect(payload.payload.payer).toBe(PAYER);
  });
});

describe("EvmChainReader", () => {
  /** A node that answers every eth_call with empty data, like an inactive precompile. */
  const silentNode = createPublicClient({
    chain: viemChainOf(qorechainTestnet),
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_call") return "0x";
        if (method === "eth_chainId") return "0x2648";
        throw new Error(`unexpected ${method}`);
      },
    }),
  }) as PublicClient;

  it("fails closed when pqcKeyStatus returns empty data", async () => {
    const reader = new EvmChainReader({ network: qorechainTestnet, publicClient: silentNode });
    await expect(reader.keyStatus(PAYER)).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(reader.nonceUsed(ESCROW, PAYER, `0x${"00".repeat(32)}`)).rejects.toBeInstanceOf(
      ChainUnavailableError,
    );
  });

  it("fails closed when the KEM registry cannot be reached", async () => {
    const reader = new EvmChainReader({
      network: qorechainTestnet,
      publicClient: silentNode,
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    await expect(reader.kemKey(PAYER)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it("reads a well-formed pqcKeyStatus answer from the precompile address", async () => {
    const calls: { to?: string }[] = [];
    const node = createPublicClient({
      chain: viemChainOf(qorechainTestnet),
      transport: custom({
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method !== "eth_call") throw new Error(`unexpected ${method}`);
          calls.push((params as [{ to?: string }])[0]);
          return encodeFunctionResult({
            abi: pqcPrecompileAbi,
            functionName: "pqcKeyStatus",
            result: [true, 1, toHex(payerKeys.publicKey), true],
          });
        },
      }),
    }) as PublicClient;
    const status = await new EvmChainReader({ network: qorechainTestnet, publicClient: node }).keyStatus(
      PAYER,
    );
    expect(status).toEqual({
      registered: true,
      algorithmId: 1,
      publicKey: payerKeys.publicKey,
      possessionProven: true,
    });
    expect(calls[0]?.to?.toLowerCase()).toBe("0x0000000000000000000000000000000000000a02");
  });
});
