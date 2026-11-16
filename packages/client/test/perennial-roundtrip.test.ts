import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateSealKeys, mldsaKeyPair, type Hex } from "@pq402/core";
import {
  MemoryChain,
  PqErc20Facilitator,
  PqPerennialFacilitator,
  qorechainTestnet,
} from "@pq402/scheme-qorechain";
import { nodeListener, PaymentGate } from "@pq402/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { afterEach, describe, expect, it } from "vitest";
import { createPq402Fetch } from "../src/index.js";

const ESCROW: Hex = "0x1111111111111111111111111111111111111111";
const VAULT: Hex = "0x8888888888888888888888888888888888888888";
const AGENT: Hex = "0x2222222222222222222222222222222222222222";
const GATEWAY: Hex = "0x3333333333333333333333333333333333333333";
const RELAYER: Hex = "0x4444444444444444444444444444444444444444";

const agentMldsa = mldsaKeyPair(new Uint8Array(32).fill(41));
const agentSeal = generateSealKeys();
const gatewayMldsa = mldsaKeyPair(new Uint8Array(32).fill(42));
const gatewaySeal = generateSealKeys();

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(buffer: bigint) {
  const chain = new MemoryChain(ESCROW);
  chain.registerKey(AGENT, agentMldsa.publicKey);
  chain.registerKemKey(AGENT, agentSeal.mlkemPublicKey);
  chain.registerKey(GATEWAY, gatewayMldsa.publicKey);
  chain.registerKemKey(GATEWAY, gatewaySeal.mlkemPublicKey);
  chain.deposit(AGENT, 1_000_000n);
  chain.openPosition(VAULT, 1n, AGENT, buffer);
  const settler = chain.settler(RELAYER);
  const facilitator = new x402Facilitator()
    .register("eip155:9800", new PqErc20Facilitator({ networks: ["eip155:9800"], reader: chain, settler }))
    .register(
      "eip155:9800",
      new PqPerennialFacilitator({ networks: ["eip155:9800"], reader: chain, settler }),
    );
  const gate = new PaymentGate({
    network: qorechainTestnet,
    escrow: ESCROW,
    vault: VAULT,
    facilitator,
    kemKeys: chain,
    gateway: { address: GATEWAY, mldsaSecretKey: gatewayMldsa.secretKey, sealKeys: gatewaySeal },
    routes: { "POST /v1/chat/completions": { price: "0.002 fUSD", payTo: GATEWAY } },
  });
  const server = createServer(
    nodeListener(gate, async (req) => ({
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(
        JSON.stringify({ answer: `you asked ${new TextDecoder().decode(req.body)}` }),
      ),
    })),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { chain, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions` };
}

const agentFetch = (chain: MemoryChain, perennial: boolean) =>
  createPq402Fetch({
    payer: AGENT,
    mldsaSecretKey: agentMldsa.secretKey,
    sealKeys: agentSeal,
    keys: chain,
    chainId: "qorechain-diana",
    maxAmount: 5_000n,
    ...(perennial ? { perennial: { positionId: 1n } } : {}),
  });

describe("an agent paying per inference call from a Perennial position", () => {
  it("offers both schemes in one 402", async () => {
    const { url } = await start(10_000n);
    const res = await fetch(url, { method: "POST" });
    const body = (await res.json()) as { accepts: { scheme: string; amount: string }[] };
    expect(body.accepts.map((a) => [a.scheme, a.amount])).toEqual([
      ["pq-perennial", "2000"],
      ["pq-erc20", "2000"],
    ]);
  });

  it("pays each call with a vault spend, sealed both ways, until the buffer runs out", async () => {
    const { chain, url } = await start(5_000n);
    const pay = agentFetch(chain, true);
    for (const n of [1, 2]) {
      const res = await pay(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: `call ${n}`,
      });
      expect(await res.json()).toEqual({ answer: `you asked call ${n}` });
      expect(res.payment?.requirements.scheme).toBe("pq-perennial");
      expect(res.payment?.requestSealed).toBe(true);
      expect(res.payment?.receipt?.gateway).toBe(GATEWAY);
    }
    const position = await chain.perennialPosition(VAULT, 1n);
    expect(position.buffer).toBe(1_000n);
    expect(position.nonce).toBe(2n);
    expect(chain.paidTo(GATEWAY)).toBe(4_000n);

    await expect(pay(url, { method: "POST", body: "call 3" })).rejects.toMatchObject({
      reason: "insufficient_funds",
    });
    expect(chain.paidTo(GATEWAY)).toBe(4_000n);
  });

  it("falls back to the escrow when the client has no position", async () => {
    const { chain, url } = await start(5_000n);
    const res = await agentFetch(chain, false)(url, { method: "POST", body: "hi" });
    expect(res.payment?.requirements.scheme).toBe("pq-erc20");
    expect(await chain.escrowBalance(ESCROW, AGENT)).toBe(998_000n);
    expect((await chain.perennialPosition(VAULT, 1n)).buffer).toBe(5_000n);
  });
});
